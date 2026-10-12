import { PgBoss } from 'pg-boss';
import { eq, sql } from 'drizzle-orm';
import {
  config,
  MAX_ATTEMPTS,
  SCAN_HEARTBEAT_SECONDS,
  SCAN_ATTEMPT_EXPIRY_SECONDS,
} from '../config.ts';
import { emitEvent } from '../db/scan-event-store.ts';
import { log } from '../logger.ts';
import { tx } from '../db/database-client.ts';
import { scans } from '../db/schema.ts';

const QUEUE_MONITOR_INTERVAL_SECONDS = 10;
const QUEUE_SUPERVISE_INTERVAL_SECONDS = 10;
// Recovery must survive long outages.
const FINALIZER_RETRY_LIMIT = 1_000;
const FINALIZER_RETRY_DELAY_SECONDS = 1;
// Dead-lettered scans must still finish.
const FINALIZER_RETRY_DELAY_MAX_SECONDS = 5;
const SCAN_RETRY_DELAY_SECONDS = 1;
// Stay inside the scan time budget.
const SCAN_RETRY_DELAY_MAX_SECONDS = 5;
const FINALIZER_POLL_INTERVAL_SECONDS = 2;

export const SCAN_QUEUE = 'scans';
export const FINALIZE_QUEUE = 'scan-finalize';
export const boss = new PgBoss({
  connectionString: config.databaseUrl,
  monitorIntervalSeconds: QUEUE_MONITOR_INTERVAL_SECONDS,
  superviseIntervalSeconds: QUEUE_SUPERVISE_INTERVAL_SECONDS,
});
boss.on('error', (error) => log('error', 'pg-boss error', { error: String(error) }));
boss.on('warning', (warning) => log('warn', 'pg-boss warning', { warning }));

export async function startQueue() {
  await boss.start();
  await boss.createQueue(FINALIZE_QUEUE, {
    policy: 'standard',
    retryLimit: FINALIZER_RETRY_LIMIT,
    retryDelay: FINALIZER_RETRY_DELAY_SECONDS,
    retryBackoff: true,
    retryDelayMax: FINALIZER_RETRY_DELAY_MAX_SECONDS,
  });
  // retryLimit = MAX_ATTEMPTS - 1: first delivery plus retries gives MAX_ATTEMPTS worker
  // attempts. heartbeat/expiry drive redelivery of stalled workers; exhausted jobs
  // dead-letter to FINALIZE_QUEUE so the scan still reaches a terminal state.
  await boss.createQueue(SCAN_QUEUE, {
    policy: 'standard',
    retryLimit: MAX_ATTEMPTS - 1,
    retryDelay: SCAN_RETRY_DELAY_SECONDS,
    retryBackoff: true,
    retryDelayMax: SCAN_RETRY_DELAY_MAX_SECONDS,
    heartbeatSeconds: SCAN_HEARTBEAT_SECONDS,
    expireInSeconds: SCAN_ATTEMPT_EXPIRY_SECONDS,
    deadLetter: FINALIZE_QUEUE,
  });
}

/**
 * Safety net for scans whose every attempt died without a terminal row: the dead-lettered
 * job marks the scan failed, so nothing hangs in 'running' forever.
 */
export async function startFinalizer() {
  return boss.work<{ scanId: string }>(
    FINALIZE_QUEUE,
    { pollingIntervalSeconds: FINALIZER_POLL_INTERVAL_SECONDS },
    async ([job]) => {
      await tx(async (c) => {
        const [row] = await c
          .select({ status: scans.status })
          .from(scans)
          .where(eq(scans.id, job.data.scanId))
          .for('update');
        if (!row || !['queued', 'running'].includes(row.status)) return;
        await c
          .update(scans)
          .set({
            status: 'failed',
            stage: 'publish',
            finishedAt: sql`now()`,
            error: { code: 'SCAN_FAILED', message: 'Scan exhausted retries', retryable: true },
          })
          .where(eq(scans.id, job.data.scanId));
        await emitEvent(c, job.data.scanId, null, 'publish', 'error', 'Scan failed');
      });
    },
  );
}
