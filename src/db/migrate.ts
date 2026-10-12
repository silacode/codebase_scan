import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { tx } from './database-client.ts';

/**
 * Idempotent bootstrap: DDL from schema.sql plus additive migrations. The advisory lock
 * serializes concurrent boots; legacy active scans refuse to start under pg-boss.
 */
export async function migrate() {
  await tx(async (c) => {
    await c.execute(sql`SELECT pg_advisory_xact_lock(hashtext('scan_schema_migration'))`);
    // The bootstrap DDL is deliberately retained for existing installs and fresh databases.
    await c.execute(sql.raw(await readFile(new URL('./schema.sql', import.meta.url), 'utf8')));
    await c.execute(sql`ALTER TABLE scans ADD COLUMN IF NOT EXISTS queue_job_id uuid`);
    const legacy = await c.execute(
      sql`SELECT 1 FROM scans WHERE status IN ('queued','running') AND queue_job_id IS NULL LIMIT 1`,
    );
    if (legacy.rows.length)
      throw new Error(
        'Active legacy scans exist: drain or cancel them under the old app before restarting with pg-boss',
      );
    await c.execute(
      sql`ALTER TABLE scans DROP COLUMN IF EXISTS lease_until, DROP COLUMN IF EXISTS worker`,
    );
  });
}
