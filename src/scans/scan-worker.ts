import { config } from '../config.ts';
import { tx } from '../db/database-client.ts';
import { scans } from '../db/schema.ts';
import { boss, SCAN_QUEUE } from '../queue/scan-queue.ts';
import { eq } from 'drizzle-orm';
import { owns } from './scan-attempt-store.ts';
import { runJob } from './pipeline/scan-pipeline.ts';

// New-job pickup vs polling cost.
const WORKER_POLL_INTERVAL_SECONDS = 2;
// Before the queue calls the heartbeat stale.
const HEARTBEAT_REFRESH_SECONDS = 10;

/**
 * Claim scan attempts from the queue. The claim transaction re-checks under the scan's row
 * lock that the scan is still open and this delivery is its current attempt (queue job ID
 * matches, attempt = retryCount + 1, lease still ours) before marking it running; any
 * mismatch throws and pg-boss requeues/acks the delivery.
 */
export async function startWorker() {
  return boss.work<{ scanId: string }>(
    SCAN_QUEUE,
    {
      pollingIntervalSeconds: WORKER_POLL_INTERVAL_SECONDS,
      localConcurrency: config.workerSlots,
      heartbeatRefreshSeconds: HEARTBEAT_REFRESH_SECONDS,
    },
    async ([delivery]) => {
      const job = await tx(async (c) => {
        const [row] = await c
          .select()
          .from(scans)
          .where(eq(scans.id, delivery.data.scanId))
          .for('update');
        if (!row || ['completed', 'failed', 'cancelled'].includes(row.status)) return undefined;
        if (row.queueJobId !== delivery.id) throw Error('Queue job ID mismatch');
        const attempt = delivery.retryCount + 1;
        if (
          delivery.signal.aborted ||
          row.attempt >= attempt ||
          !(await owns(c, {
            ...row,
            attempt,
            startedAt: row.startedAt ?? new Date(),
            queueJobId: delivery.id,
          }))
        )
          throw new Error('Scan ownership lost');
        const startedAt = row.startedAt ?? new Date();
        await c
          .update(scans)
          .set({ status: 'running', attempt, startedAt, error: null })
          .where(eq(scans.id, delivery.data.scanId));
        return { ...row, attempt, startedAt, queueJobId: delivery.id };
      });
      if (job) await runJob(job, delivery.signal);
    },
  );
}
