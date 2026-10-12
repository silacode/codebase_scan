import { fromDrizzle } from 'pg-boss';
import { and, eq, sql } from 'drizzle-orm';
import { db, tx } from '../db/database-client.ts';
import type { Transaction } from '../db/database-client.ts';
import { emitEvent } from '../db/scan-event-store.ts';
import { boss, SCAN_QUEUE } from '../queue/scan-queue.ts';
import {
  scans,
  scanStages,
  findings as findingsTable,
  issues as issuesTable,
} from '../db/schema.ts';
import type { Scan } from '../db/schema.ts';
import type { Finding } from '../scanners/scanner-types.ts';
import type { Issue } from '../reports/issue-types.ts';
import { stages } from './pipeline/pipeline-stages.ts';

// Lease fencing for scan writes. pg-boss redelivers a job when its heartbeat lapses or the
// worker dies, so two workers can briefly run the same scan. Every write below first proves,
// inside the caller's transaction, that this worker still owns the current attempt; otherwise
// it writes nothing and returns false, and the caller abandons the scan.

/** A scan attempt as claimed from the queue. */
export type Job = Pick<Scan, 'id' | 'owner' | 'repo' | 'ref' | 'commitSha' | 'attempt'> & {
  startedAt: Date;
  queueJobId: string;
};

/**
 * True while this worker still holds the pg-boss lease for this attempt. Each clause of the
 * guard rejects one concrete way ownership is lost: the job was cancelled or completed
 * elsewhere (no longer active), a newer redelivery took over (`retryCount + 1 !== attempt`),
 * or the heartbeat/expiry window lapsed and pg-boss is handing the job to another worker.
 * The final `boss.touch` then refreshes the heartbeat atomically; `affected !== 1` means we
 * lost that race and must not persist anything else for this attempt.
 */
export async function owns(c: Transaction, job: Job) {
  const [queued] = await boss.findJobs(SCAN_QUEUE, {
    id: job.queueJobId,
    db: fromDrizzle(c, sql),
  });
  const now = new Date(
    (await c.execute(sql`SELECT clock_timestamp() AS at`)).rows[0].at as string,
  ).getTime();

  if (
    !queued ||
    queued.state !== 'active' ||
    queued.retryCount + 1 !== job.attempt ||
    !queued.heartbeatOn ||
    !queued.heartbeatSeconds ||
    now >= new Date(queued.heartbeatOn).getTime() + queued.heartbeatSeconds * 1000 ||
    now >= new Date(queued.startedOn).getTime() + queued.expireInSeconds * 1000
  )
    return false;
  return (
    (
      await boss.touch(
        SCAN_QUEUE,
        { id: job.queueJobId, retryCount: job.attempt - 1 },
        { db: fromDrizzle(c, sql) },
      )
    ).affected === 1
  );
}

/** Stage outputs already persisted with outcome 'ok' for this scan, keyed by stage name. */
export async function completedStages(job: Job) {
  const saved = await db
    .select({ stage: scanStages.stage, output: scanStages.output })
    .from(scanStages)
    .where(and(eq(scanStages.scanId, job.id), eq(scanStages.outcome, 'ok')));
  return new Map<string, unknown>(saved.map((row) => [row.stage, row.output]));
}

/**
 * Persist one stage's result and advance the scan's stage/progress columns. The row lock on
 * the scan (still `running`, same attempt) plus the lease check make this a no-op that
 * returns false when another worker took over; callers must treat that as ownership lost.
 * The upsert is what lets a redelivered attempt resume instead of redoing finished stages.
 */
export async function saveStage(
  job: Job,
  stage: string,
  output: unknown,
  outcome: 'ok' | 'partial' | 'failed' | 'skipped',
  startedAt: Date,
  error?: string,
) {
  return tx(async (c) => {
    const [row] = await c
      .select({ id: scans.id })
      .from(scans)
      .where(and(eq(scans.id, job.id), eq(scans.attempt, job.attempt), eq(scans.status, 'running')))
      .for('update');
    if (!row || !(await owns(c, job))) return false;

    await c
      .insert(scanStages)
      .values({
        scanId: job.id,
        stage,
        output,
        outcome,
        startedAt,
        endedAt: new Date(),
        error: error ?? null,
      })
      .onConflictDoUpdate({
        target: [scanStages.scanId, scanStages.stage],
        set: { output, outcome, startedAt, endedAt: sql`now()`, error: error ?? null },
      });
    const progress = stages.find((s) => s.name === stage)?.progress ?? 100;
    await c
      .update(scans)
      .set({ stage, progress })
      .where(and(eq(scans.id, job.id), eq(scans.attempt, job.attempt)));
    await emitEvent(
      c,
      job.id,
      job.attempt,
      stage,
      outcome === 'ok' ? 'info' : 'warn',
      outcome === 'ok' ? `${stage} finished` : `${stage} partial: ${error}`,
    );
    return true;
  });
}

/**
 * Terminal transition for one attempt: store findings and issues (completed only), emit the
 * final event, and set status/progress/report/error. `cancelRequested` wins over completion.
 * Returns false when ownership was lost mid-write; the caller then lets pg-boss retry rather
 * than reporting success. `emitEvent` throwing 'Scan ownership lost' aborts the transaction
 * so a half-written terminal state can never commit.
 */
export async function finish(
  job: Job,
  status: 'completed' | 'failed' | 'cancelled',
  report?: Scan['report'],
  findings: Finding[] = [],
  issues: Issue[] = [],
  error?: { code: string; message: string; retryable: boolean },
) {
  return tx(async (c) => {
    const [row] = await c
      .select({ cancelRequested: scans.cancelRequested })
      .from(scans)
      .where(and(eq(scans.id, job.id), eq(scans.attempt, job.attempt), eq(scans.status, 'running')))
      .for('update');
    if (!row || !(await owns(c, job))) return false;
    if (row.cancelRequested) {
      status = 'cancelled';
      report = undefined;
      error = undefined;
    }

    if (status === 'completed') {
      for (const f of findings)
        await c
          .insert(findingsTable)
          .values({
            scanId: job.id,
            findingId: f.id,
            severityRank: { critical: 4, high: 3, medium: 2, low: 1 }[f.severity],
            data: f,
          })
          .onConflictDoUpdate({
            target: [findingsTable.scanId, findingsTable.findingId],
            set: { data: f },
          });
      for (const issue of issues)
        await c
          .insert(issuesTable)
          .values({ scanId: job.id, issueId: issue.id, priority: issue.priority, data: issue })
          .onConflictDoUpdate({
            target: [issuesTable.scanId, issuesTable.issueId],
            set: { data: issue, priority: issue.priority },
          });
    }
    if (
      !(await emitEvent(
        c,
        job.id,
        job.attempt,
        'publish',
        status === 'failed' ? 'error' : 'info',
        `Scan ${status}`,
      ))
    )
      throw new Error('Scan ownership lost');
    await c
      .update(scans)
      .set({
        status,
        stage: 'publish',
        progress: status === 'completed' ? 100 : 0,
        report: report ?? null,
        error: error ?? null,
        finishedAt: sql`now()`,
      })
      .where(and(eq(scans.id, job.id), eq(scans.attempt, job.attempt)));
    return true;
  });
}
