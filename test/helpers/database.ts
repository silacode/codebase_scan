import { beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import pg from 'pg';

const admin = process.env.DATABASE_URL ?? 'postgres://scan:scan@localhost:5433/scan';
export const adminUrl = new URL(admin);
export const testUrl = new URL(admin);
if (
  !['localhost', '127.0.0.1'].includes(adminUrl.hostname) ||
  adminUrl.port !== '5433' ||
  adminUrl.pathname !== '/scan'
)
  throw new Error('Integration cleanup requires the local scan database on port 5433');
testUrl.pathname = '/scan_test';
const adminPool = new pg.Pool({ connectionString: adminUrl.toString() });
try {
  const existing = await adminPool.query("SELECT 1 FROM pg_database WHERE datname='scan_test'");
  if (!existing.rowCount) await adminPool.query('CREATE DATABASE scan_test');
} finally {
  await adminPool.end();
}
process.env.DATABASE_URL = testUrl.toString();
const client = await import('../../src/db/database-client.ts');
const migrations = await import('../../src/db/migrate.ts');
const events = await import('../../src/db/scan-event-store.ts');
const queue = await import('../../src/queue/scan-queue.ts');
const worker = await import('../../src/scans/scan-worker.ts');
const lease = await import('../../src/scans/scan-attempt-store.ts');
const pipeline = await import('../../src/scans/pipeline/scan-pipeline.ts');
export const { tx } = client;
export const { emitEvent } = events;
export const { boss, SCAN_QUEUE, FINALIZE_QUEUE, startQueue, startFinalizer } = queue;
export const { startWorker } = worker;
export const { runJob } = pipeline;
export const { saveStage } = lease;
export const pool = client.pool;
export async function waitFor(id: string, status: string, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const row = (await pool.query('SELECT status,stage FROM scans WHERE id=$1', [id])).rows[0];
    if (row?.status === status) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`scan ${id} did not reach ${status}`);
}
export async function processScan(id: string) {
  const worker = await startWorker();
  try {
    await waitFor(id, 'completed');
  } finally {
    await boss.offWork(SCAN_QUEUE, { id: worker });
  }
}
export function jobRow(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    owner: row.owner as string,
    repo: row.repo as string,
    ref: row.ref as string,
    commitSha: row.commit_sha as string,
    attempt: row.attempt as number,
    startedAt: row.started_at as Date,
    queueJobId: row.queue_job_id as string,
  };
}
beforeAll(async () => {
  const cleanup = new pg.Client({ connectionString: testUrl.toString() });
  await cleanup.connect();
  try {
    assert.equal(
      (await cleanup.query('SELECT current_database() AS name')).rows[0].name,
      'scan_test',
    );
    if ((await cleanup.query("SELECT to_regclass('public.scans') AS table")).rows[0].table)
      await cleanup.query('TRUNCATE scans CASCADE');
  } finally {
    await cleanup.end();
  }
  await migrations.migrate();
  await startQueue();
});
beforeEach(async () => {
  await boss.offWork(SCAN_QUEUE);
  await boss.offWork(FINALIZE_QUEUE);
  await boss.deleteAllJobs(SCAN_QUEUE);
  await boss.deleteAllJobs(FINALIZE_QUEUE);
  await pool.query(
    'TRUNCATE scans,scan_stages,scan_events,findings,issues,idempotency_keys,cache CASCADE',
  );
});
afterAll(async () => {
  await boss.stop();
  await pool.end();
});
