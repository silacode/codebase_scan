import type { FastifyInstance } from 'fastify';
import { config } from './config.ts';
import { migrate } from './db/migrate.ts';
import { pool } from './db/database-client.ts';
import { log } from './logger.ts';
import { createApi } from './app.ts';
import { startWorker } from './scans/scan-worker.ts';
import { boss, startFinalizer, startQueue } from './queue/scan-queue.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;

let app: FastifyInstance | undefined;
let stopping = false;
let startup: Promise<void>;
let shutdown: Promise<void> | undefined;

/** Idempotent shutdown: let startup settle, close the API, stop the queue, end the pool. */
function stop() {
  stopping = true;
  return (shutdown ??= (async () => {
    await startup.catch(() => {});
    try {
      await app?.close();
    } finally {
      try {
        await boss.stop({ graceful: true, timeout: SHUTDOWN_TIMEOUT_MS });
      } finally {
        await pool.end();
      }
    }
  })());
}
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(
    signal,
    () => void stop().catch((error) => log('error', 'Shutdown failed', { error: String(error) })),
  );
// Role-aware boot; every step re-checks `stopping` so a signal during startup unwinds
// through the same shutdown path instead of leaving half-open servers behind.
startup = (async () => {
  await migrate();
  if (stopping) return;
  await startQueue();
  if (stopping) return;
  if (!config.githubToken)
    log('warn', 'GITHUB_TOKEN missing; unauthenticated quota: 60 REST calls/hour (~20 scans/hour)');
  if (config.role !== 'api') {
    await startFinalizer();
    if (stopping) return;
    await startWorker();
    if (stopping) return;
  }
  if (config.role !== 'worker') {
    app = await createApi();
    if (stopping) return;
    await app.listen({ port: config.port, host: '0.0.0.0' });
    if (stopping) return;
    log('info', 'API listening', { port: config.port });
  }
})();
try {
  await startup;
} catch (error) {
  const interrupted = stopping;
  await stop();
  if (!interrupted) throw error;
}
