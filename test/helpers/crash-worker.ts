import { readFile } from 'node:fs/promises';
import { boss, startQueue } from '../../src/queue/scan-queue.ts';
import { pool } from '../../src/db/database-client.ts';
import { startWorker } from '../../src/scans/scan-worker.ts';

const archive = await readFile(process.env.SCAN_TEST_ARCHIVE!);
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes('/tarball/')) return new Response(Uint8Array.from(archive));
  if (url.includes('www.cisa.gov') && process.env.SCAN_TEST_WORKER_NORMAL)
    return Response.json({ vulnerabilities: [] });
  if (url.includes('api.osv.dev/v1/querybatch'))
    return new Promise<Response>((_resolve, reject) => {
      if (!process.env.SCAN_TEST_COOPERATIVE) return;
      const signal = init?.signal;
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  throw new Error(`Unexpected upstream in crash worker: ${new URL(url).hostname}`);
};
await startQueue();
await startWorker();
process.once('SIGTERM', () => {
  void (async () => {
    await boss.stop({ timeout: 1500 });
    await pool.end();
  })();
});
