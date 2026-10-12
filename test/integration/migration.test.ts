import { test } from 'vitest';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { pool, testUrl, adminUrl } from '../helpers/database.ts';
import { sha } from '../helpers/fixtures.ts';

test('fresh, existing and concurrent migrations preserve reports and refuse active legacy work', async () => {
  const name = 'scan_migration_test';
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  let client: pg.Client | undefined;
  try {
    await admin.query('DROP DATABASE IF EXISTS scan_migration_test WITH (FORCE)');
    await admin.query('CREATE DATABASE scan_migration_test');
    client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, name);
    async function runMigration() {
      const child = spawn(process.execPath, ['test/helpers/migrate.ts'], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: url.toString() },
      });
      let logs = '';
      child.stderr.on('data', (data: Buffer) => {
        logs += data.toString();
      });
      const [code] = await once(child, 'exit');
      return { code, logs };
    }
    assert.equal((await runMigration()).code, 0, 'fresh migration');
    const columns = async () =>
      (
        await client!.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='scans' ORDER BY column_name",
        )
      ).rows.map((r) => r.column_name as string);
    assert.ok((await columns()).includes('queue_job_id'));
    assert.ok(!(await columns()).includes('worker'));
    await client.query(
      'ALTER TABLE scans ADD COLUMN worker text, ADD COLUMN lease_until timestamptz',
    );
    const reportId = randomUUID(),
      legacyId = randomUUID();
    await client.query(
      `INSERT INTO scans(id,owner,repo,ref,commit_sha,repo_size_kb,scan_key,status,report)
      VALUES($1,'test','report','main',$2,1,$3,'completed',$4)`,
      [reportId, sha('report'), reportId, { preserved: true }],
    );
    await client.query(
      `INSERT INTO scans(id,owner,repo,ref,commit_sha,repo_size_kb,scan_key,status,worker)
      VALUES($1,'test','old','main',$2,1,$3,'running','old-worker')`,
      [legacyId, sha('old'), legacyId],
    );
    const before = (await client.query('SELECT report FROM scans WHERE id=$1', [reportId])).rows[0]
      .report;
    const refused = await runMigration();
    assert.notEqual(refused.code, 0);
    assert.match(refused.logs, /drain or cancel them under the old app/);
    assert.ok((await columns()).includes('worker'), 'rollback must leave legacy worker columns');
    assert.equal(
      (await client.query('SELECT status FROM scans WHERE id=$1', [legacyId])).rows[0].status,
      'running',
    );
    await client.query("UPDATE scans SET status='cancelled' WHERE id=$1", [legacyId]);
    const [a, b] = await Promise.all([runMigration(), runMigration()]);
    assert.equal(a.code, 0, a.logs);
    assert.equal(b.code, 0, b.logs);
    assert.ok(!(await columns()).includes('worker'));
    assert.ok(!(await columns()).includes('lease_until'));
    assert.deepEqual(
      (await client.query('SELECT report FROM scans WHERE id=$1', [reportId])).rows[0].report,
      before,
    );
    assert.equal((await runMigration()).code, 0, 'repeat startup');
  } finally {
    await client?.end();
    await admin.query('DROP DATABASE IF EXISTS scan_migration_test WITH (FORCE)');
    await admin.end();
  }
});

test('SIGTERM during a blocked migration prevents API startup and exits cleanly', async () => {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const holder = new pg.Client({ connectionString: testUrl.toString() });
  await holder.connect();
  let locked = false;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await holder.query('BEGIN');
    locked = true;
    await holder.query("SELECT pg_advisory_xact_lock(hashtext('scan_schema_migration'))");
    const tag = `scan-startup-stop-${randomUUID()}`;
    const url = new URL(testUrl);
    url.searchParams.set('application_name', tag);
    child = spawn(process.execPath, ['src/index.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url.toString(), ROLE: 'api', PORT: String(port) },
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exited = once(child, 'exit');
    let waiting = false;
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      waiting = !!(
        await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname='scan_test' AND application_name=$1 AND wait_event_type='Lock'",
          [tag],
        )
      ).rowCount;
      if (waiting) break;
      if (child.exitCode !== null) assert.fail(output);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(waiting, true, output);
    assert.equal(child.kill('SIGTERM'), true);
    await holder.query('COMMIT');
    locked = false;
    const force = setTimeout(() => child?.kill('SIGKILL'), 12000);
    try {
      const [code, signal] = await exited;
      assert.equal(code, 0, output);
      assert.equal(signal, null, output);
    } finally {
      clearTimeout(force);
    }
    assert.doesNotMatch(output, /API listening|Cannot use a pool after calling end on the pool/);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/healthz`));
  } finally {
    if (locked) await holder.query('ROLLBACK');
    await holder.end();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
});
