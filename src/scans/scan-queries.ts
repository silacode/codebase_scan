import { constants as HTTP } from 'node:http2';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/database-client.ts';
import type { Transaction } from '../db/database-client.ts';
import { scans, scanEvents, findings, issues } from '../db/schema.ts';
import { ScanError } from '../errors.ts';

const SNAPSHOT_EVENT_COUNT = 100;

// The full scan state in one payload: status, stage/progress, queue position, report and
// the last 100 events, oldest first. Throws ScanError('NOT_FOUND', 404) for missing scans.
export async function snapshot(id: string, client: Transaction | typeof db = db) {
  const [scan] = await client.select().from(scans).where(eq(scans.id, id));
  if (!scan) throw new ScanError('NOT_FOUND', 'Scan not found', false, HTTP.HTTP_STATUS_NOT_FOUND);
  // Queue position: how many queued scans are ahead of this one (creation order, then id).
  const [position] =
    scan.status === 'queued'
      ? await client
          .select({ count: sql<number>`count(*)::int` })
          .from(scans)
          .where(
            and(
              eq(scans.status, 'queued'),
              sql`(${scans.createdAt}, ${scans.id}) < (SELECT created_at, id FROM scans WHERE id=${id})`,
            ),
          )
      : [];
  const events = await client
    .select({
      seq: scanEvents.seq,
      at: scanEvents.at,
      stage: scanEvents.stage,
      level: scanEvents.level,
      message: scanEvents.message,
    })
    .from(scanEvents)
    .where(eq(scanEvents.scanId, id))
    .orderBy(desc(scanEvents.seq))
    .limit(SNAPSHOT_EVENT_COUNT);
  return {
    id: scan.id,
    owner: scan.owner,
    repo: scan.repo,
    ref: scan.ref,
    commitSha: scan.commitSha,
    status: scan.status,
    stage: scan.stage,
    progress: scan.progress,
    queuePosition: position?.count ?? null,
    error: scan.error,
    report: scan.report,
    createdAt: scan.createdAt,
    startedAt: scan.startedAt,
    finishedAt: scan.finishedAt,
    events: events.reverse(),
  };
}
/** Findings for a scan, most severe first, with JSONB filters and a total count. */
export async function listFindings(
  id: string,
  offset: number,
  limit: number,
  severity?: string,
  dev?: string,
  direct?: string,
) {
  await snapshot(id);
  const conditions = [eq(findings.scanId, id)];
  if (severity) conditions.push(sql`${findings.data}->>'severity' = ${severity}`);
  if (dev) conditions.push(sql`${findings.data}->>'dev' = ${dev}`);
  if (direct) conditions.push(sql`${findings.data}->>'direct' = ${direct}`);
  const where = and(...conditions);
  const [count] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(findings)
    .where(where);
  const rows = await db
    .select({ data: findings.data })
    .from(findings)
    .where(where)
    .orderBy(desc(findings.severityRank), asc(findings.findingId))
    .limit(limit)
    .offset(offset);
  return { items: rows.map((row) => row.data), total: count.count, offset, limit };
}

/** Issues for a scan, highest priority first. */
export async function listIssues(id: string) {
  await snapshot(id);
  const rows = await db
    .select({ data: issues.data })
    .from(issues)
    .where(eq(issues.scanId, id))
    .orderBy(desc(issues.priority), asc(issues.issueId));
  return { items: rows.map((row) => row.data) };
}

/** Queue metrics for /api/metrics: depth, age, and 1h completion counts. */
export async function metrics() {
  const result = await db.execute(sql`SELECT count(*) FILTER (WHERE status='queued')::int AS queued,
    count(*) FILTER (WHERE status='running')::int AS running,
    coalesce(max(extract(epoch from now()-created_at)) FILTER (WHERE status='queued'),0) AS oldest_queued_age,
    count(*) FILTER (WHERE status='completed' AND finished_at>now()-interval '1 hour')::int AS completed,
    count(*) FILTER (WHERE status='failed' AND finished_at>now()-interval '1 hour')::int AS failed FROM scans`);
  return { ...result.rows[0], oldest_queued_age: Number(result.rows[0].oldest_queued_age) };
}
