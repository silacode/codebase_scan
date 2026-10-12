import { createHash, randomUUID } from 'node:crypto';
import { constants as HTTP } from 'node:http2';
import { and, eq, inArray, gt, lt, sql, desc } from 'drizzle-orm';
import { fromDrizzle } from 'pg-boss';
import { config, IDEMPOTENCY_TTL_MS, RESULT_REUSE_MS, SCANNER_VERSION } from '../config.ts';
import { db, tx } from '../db/database-client.ts';
import { scans, idempotencyKeys } from '../db/schema.ts';
import { emitEvent } from '../db/scan-event-store.ts';
import { ScanError, uniqueViolation } from '../errors.ts';
import { parseRepoUrl, resolveRepo } from '../integrations/github-repository.ts';
import { isValidRef } from '../contracts/repo-url.ts';
import { boss, SCAN_QUEUE } from '../queue/scan-queue.ts';
import { snapshot } from './scan-queries.ts';
import type { z } from 'zod';
import type { submitBody } from '../api/scan-request-schemas.ts';

type Input = z.infer<typeof submitBody>;
// Empty keys can't identify a request.
const MIN_IDEMPOTENCY_KEY_LENGTH = 1;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const SUBMISSION_WINDOW_MS = 60_000;

type ScanStatus = typeof scans.$inferSelect.status;
type Repo = Awaited<ReturnType<typeof resolveRepo>>;

function requestHash(
  parsed: { owner: string; repo: string },
  ref: string | undefined,
  force: boolean,
) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        owner: parsed.owner.toLowerCase(),
        repo: parsed.repo.toLowerCase(),
        ref: ref ?? null,
        force,
      }),
    )
    .digest('hex');
}

function assertKeyLength(key: string | undefined) {
  if (
    key !== undefined &&
    (key.length < MIN_IDEMPOTENCY_KEY_LENGTH || key.length > MAX_IDEMPOTENCY_KEY_LENGTH)
  )
    throw new ScanError(
      'INVALID_IDEMPOTENCY_KEY',
      `Idempotency-Key must be ${MIN_IDEMPOTENCY_KEY_LENGTH}–${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      false,
      HTTP.HTTP_STATUS_BAD_REQUEST,
    );
}

/** A stored idempotency response, or undefined; a hash mismatch means key reuse. */
async function storedResponse(key: string, hash: string) {
  const [row] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
  if (!row) return undefined;
  if (row.requestHash !== hash)
    throw new ScanError(
      'IDEMPOTENCY_KEY_REUSED',
      'Key already used for another request',
      false,
      HTTP.HTTP_STATUS_UNPROCESSABLE_ENTITY,
    );
  return { status: row.statusCode, data: row.response, id: row.scanId };
}

/** Drop stale rows for `key`, then replay a fresh one if present. */
async function replayFresh(key: string, hash: string) {
  await db
    .delete(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.key, key),
        lt(
          idempotencyKeys.createdAt,
          sql`now()-(${IDEMPOTENCY_TTL_MS} * interval '1 millisecond')`,
        ),
      ),
    );
  const [fresh] = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.key, key),
        gt(
          idempotencyKeys.createdAt,
          sql`now()-(${IDEMPOTENCY_TTL_MS} * interval '1 millisecond')`,
        ),
      ),
    );
  if (!fresh) return undefined;
  if (fresh.requestHash !== hash)
    throw new ScanError(
      'IDEMPOTENCY_KEY_REUSED',
      'Key already used for another request',
      false,
      HTTP.HTTP_STATUS_UNPROCESSABLE_ENTITY,
    );
  return { status: fresh.statusCode, data: fresh.response, id: fresh.scanId };
}

/** Per-IP active-scan and submission limits, plus global queue depth. */
async function checkLimits(
  ip: string,
  rates: Map<string, number[]>,
  limits: { active: number; submitsPerMinute: number },
) {
  const [active] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scans)
    .where(and(eq(scans.clientIp, ip), inArray(scans.status, ['queued', 'running'])));
  if (active.count >= limits.active)
    throw new ScanError(
      'TOO_MANY_ACTIVE_SCANS',
      'Too many active scans for this IP',
      true,
      HTTP.HTTP_STATUS_TOO_MANY_REQUESTS,
    );

  // Sliding minute window per IP (in-memory, so per-instance only).
  const now = Date.now();
  const recent = (rates.get(ip) ?? []).filter((t) => now - t < SUBMISSION_WINDOW_MS);
  if (recent.length >= limits.submitsPerMinute)
    throw new ScanError(
      'RATE_LIMITED',
      'Too many submissions for this IP',
      true,
      HTTP.HTTP_STATUS_TOO_MANY_REQUESTS,
    );
  recent.push(now);
  rates.set(ip, recent);

  const [queued] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scans)
    .where(eq(scans.status, 'queued'));
  if (queued.count >= config.maxQueued)
    throw new ScanError('OVERLOADED', 'Scan queue is full', true);
}

/** A scan of the same scanKey still active, or completed recently. */
async function findPrevious(scanKey: string) {
  const [previous] = await db
    .select({ id: scans.id, status: scans.status })
    .from(scans)
    .where(
      and(
        eq(scans.scanKey, scanKey),
        sql`(${scans.status} IN ('queued','running') OR (${scans.status}='completed' AND ${scans.finishedAt}>now()-(${RESULT_REUSE_MS} * interval '1 millisecond')))`,
      ),
    )
    .orderBy(desc(scans.createdAt))
    .limit(1);
  return previous;
}

/** An active scan of the same scanKey — the duplicate that won a submission race. */
async function findActive(scanKey: string) {
  const [active] = await db
    .select({ id: scans.id, status: scans.status })
    .from(scans)
    .where(and(eq(scans.scanKey, scanKey), inArray(scans.status, ['queued', 'running'])));
  return active;
}

/** Reply with an existing scan, flagged cached/deduplicated, recorded under `key`. */
async function replyExisting(
  key: string | undefined,
  hash: string,
  id: string,
  status: ScanStatus,
) {
  const response = {
    ...(await snapshot(id)),
    ...(status === 'completed' ? { cached: true } : { deduplicated: true }),
  };
  if (key) {
    try {
      await db.insert(idempotencyKeys).values({
        key,
        requestHash: hash,
        scanId: id,
        statusCode: HTTP.HTTP_STATUS_OK,
        response,
      });
    } catch (error) {
      if (!uniqueViolation(error)) throw error;
      const old = await storedResponse(key, hash);
      if (!old) throw error;
      return old;
    }
  }
  return { status: HTTP.HTTP_STATUS_OK, data: response, id };
}

/** Insert the scan and enqueue it in one transaction; returns the snapshot. */
async function enqueueScan(args: {
  id: string;
  repo: Repo;
  scanKey: string;
  ip: string;
  key: string | undefined;
  hash: string;
}) {
  const { id, repo, scanKey, ip, key, hash } = args;
  return tx(async (c) => {
    await c.insert(scans).values({
      id,
      owner: repo.owner,
      repo: repo.repo,
      ref: repo.ref,
      commitSha: repo.commitSha,
      repoSizeKb: repo.sizeKb,
      scanKey,
      status: 'queued',
      clientIp: ip,
    });
    const queueId = await boss.send(SCAN_QUEUE, { scanId: id }, { id, db: fromDrizzle(c, sql) });
    if (!queueId) throw new Error('Queue refused new scan');
    await c.update(scans).set({ queueJobId: queueId }).where(eq(scans.id, id));
    await emitEvent(c, id, null, 'queued', 'info', 'Scan queued');
    const data = await snapshot(id, c);
    if (key)
      await c.insert(idempotencyKeys).values({
        key,
        requestHash: hash,
        scanId: id,
        statusCode: HTTP.HTTP_STATUS_ACCEPTED,
        response: data,
      });
    return data;
  });
}

/** Per-instance submit state: in-flight idempotency keys and per-IP submit timestamps. */
export function scanService(limits: { active: number; submitsPerMinute: number }) {
  const inFlight = new Set<string>();
  const rates = new Map<string, number[]>();
  /**
   * Submit a scan, in order: validate and hash the request (owner/repo/ref/force), replay a
   * finished idempotency-key response if one exists, enforce per-IP active and submit limits,
   * resolve the ref to a SHA, reuse a recent completed scan of the same scanKey (unless
   * forced), and finally insert the scan + enqueue it in one transaction — a unique
   * violation there means a concurrent duplicate won the race, so reply with theirs.
   * 202 = queued, 200 = existing; ScanErrors carry the client status codes.
   */
  async function submit(input: Input, key: string | undefined, ip: string) {
    const parsed = parseRepoUrl(input.repoUrl);
    const ref = input.ref ?? parsed.ref;
    if (ref && !isValidRef(ref))
      throw new ScanError('INVALID_URL', 'Invalid ref', false, HTTP.HTTP_STATUS_BAD_REQUEST);
    const hash = requestHash(parsed, ref, input.force ?? false);
    assertKeyLength(key);

    if (key && inFlight.has(key))
      throw new ScanError(
        'IDEMPOTENCY_IN_PROGRESS',
        'Request is still in progress',
        true,
        HTTP.HTTP_STATUS_CONFLICT,
      );
    if (key) inFlight.add(key);
    try {
      if (key) {
        const replay = await replayFresh(key, hash);
        if (replay) return replay;
      }

      await checkLimits(ip, rates, limits);

      const repo = await resolveRepo(parsed.owner, parsed.repo, ref);
      const scanKey = `${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}@${repo.commitSha}#${SCANNER_VERSION}`;

      // Same scanKey still active, or completed recently → don't rescan.
      if (!input.force) {
        const previous = await findPrevious(scanKey);
        if (previous) return replyExisting(key, hash, previous.id, previous.status);
      }

      const id = randomUUID();
      try {
        const response = await enqueueScan({ id, repo, scanKey, ip, key, hash });
        return { status: HTTP.HTTP_STATUS_ACCEPTED, data: response, id };
      } catch (error) {
        if (!uniqueViolation(error)) throw error;
        if (key) {
          const old = await storedResponse(key, hash);
          if (old) return old;
        }
        const active = await findActive(scanKey);
        if (!active) throw error;
        return replyExisting(key, hash, active.id, active.status);
      }
    } finally {
      if (key) inFlight.delete(key);
    }
  }
  return { submit };
}
/** Cancel a scan: cancel the queue job and write the terminal 'cancelled' row atomically. */
export async function cancel(id: string) {
  await tx(async (c) => {
    const [row] = await c
      .select({ status: scans.status, attempt: scans.attempt, queueJobId: scans.queueJobId })
      .from(scans)
      .where(eq(scans.id, id))
      .for('update');
    if (!row) throw new ScanError('NOT_FOUND', 'Scan not found', false, HTTP.HTTP_STATUS_NOT_FOUND);
    if (['completed', 'failed', 'cancelled'].includes(row.status))
      throw new ScanError(
        'ALREADY_FINISHED',
        'Scan already finished',
        false,
        HTTP.HTTP_STATUS_CONFLICT,
      );
    if (!row.queueJobId) throw new Error('Queue job ID missing');
    await boss.cancel(SCAN_QUEUE, row.queueJobId, { db: fromDrizzle(c, sql) });
    await c
      .update(scans)
      .set({ status: 'cancelled', cancelRequested: true, finishedAt: sql`now()`, stage: 'publish' })
      .where(and(eq(scans.id, id), eq(scans.attempt, row.attempt)));
    await emitEvent(c, id, null, 'publish', 'info', 'Scan cancelled');
  });
  return { id, status: 'cancellation_requested' };
}
