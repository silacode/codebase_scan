import { migrate } from '../../src/db/migrate.ts';
import { pool } from '../../src/db/database-client.ts';
import { boss, startQueue } from '../../src/queue/scan-queue.ts';

try {
  await migrate();
  await startQueue();
} finally {
  await boss.stop();
  await pool.end();
}
