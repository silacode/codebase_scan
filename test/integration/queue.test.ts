import { test } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fromDrizzle } from 'pg-boss';
import { sql } from 'drizzle-orm';
import { scans } from '../../src/db/schema.ts';
import { ScanError } from '../../src/errors.ts';
import {
  pool,
  tx,
  emitEvent,
  boss,
  SCAN_QUEUE,
  FINALIZE_QUEUE,
  startWorker,
  startFinalizer,
  saveStage,
  runJob,
  waitFor,
  processScan,
  testUrl,
  jobRow,
} from '../helpers/database.ts';
import { post, base } from '../helpers/api.ts';
import { stub, realFetch, sha, folder } from '../helpers/fixtures.ts';
const { config } = await import('../../src/config.ts');

test('running cancellation wins within 10 seconds, including during a scanner stage', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.osv.dev/v1/querybatch'))
      await new Promise((resolve) => setTimeout(resolve, 400));
    return stub(url, init);
  };
  try {
    const created = await post('cancel-running', 'running');
    const worker = await startWorker();
    for (let n = 0; n < 50; n++) {
      const stage = (await pool.query('SELECT stage FROM scans WHERE id=$1', [created.body.id]))
        .rows[0].stage;
      if (stage === 'fetch' || stage === 'scan_dependencies') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const started = Date.now();
    const cancel = await fetch(`${base}/api/scans/${created.body.id}/cancel`, { method: 'POST' });
    assert.equal(cancel.status, 202);
    await waitFor(created.body.id, 'cancelled');
    await boss.offWork(SCAN_QUEUE, { id: worker });
    assert.ok(Date.now() - started < 10000);
    assert.equal(
      (await pool.query('SELECT report FROM scans WHERE id=$1', [created.body.id])).rows[0].report,
      null,
    );
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM findings WHERE scan_id=$1', [
          created.body.id,
        ])
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM issues WHERE scan_id=$1', [
          created.body.id,
        ])
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await pool.query('SELECT status FROM scans WHERE id=$1', [created.body.id])).rows[0].status,
      'cancelled',
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('queue send shares application rollback and commit visibility', async () => {
  const id = randomUUID();
  await assert.rejects(
    tx(async (c) => {
      await c.insert(scans).values({
        id,
        owner: 'test',
        repo: 'rollback',
        ref: 'master',
        commitSha: sha('rollback'),
        repoSizeKb: 1,
        scanKey: id,
        status: 'queued',
      });
      assert.equal(
        await boss.send(
          SCAN_QUEUE,
          { scanId: id },
          {
            id,
            db: fromDrizzle(c, sql),
          },
        ),
        id,
      );
      assert.equal((await boss.findJobs(SCAN_QUEUE, { id })).length, 0);
      throw new Error('rollback');
    }),
    /rollback/,
  );
  assert.equal((await pool.query('SELECT 1 FROM scans WHERE id=$1', [id])).rowCount, 0);
  assert.equal((await boss.findJobs(SCAN_QUEUE, { id })).length, 0);
});

test('a failed queue attempt rejects stale checkpoint writes even before redelivery', async () => {
  const created = await post('stale', 'stale');
  const [delivery] = await boss.fetch<{ scanId: string }>(SCAN_QUEUE);
  assert.equal(delivery.id, created.body.id);
  const job = jobRow(
    (
      await pool.query(
        `UPDATE scans SET status='running',attempt=1,started_at=now()
    WHERE id=$1 RETURNING *`,
        [delivery.id],
      )
    ).rows[0],
  );
  assert.equal(await saveStage(job, 'fetch', { done: true }, 'ok', new Date()), true);
  assert.equal((await boss.fail(SCAN_QUEUE, delivery, { message: 'transient' })).affected, 1);
  assert.equal(await saveStage(job, 'fetch', { stale: true }, 'ok', new Date()), false);
  assert.equal(
    (
      await pool.query("SELECT output FROM scan_stages WHERE scan_id=$1 AND stage='fetch'", [
        job.id,
      ])
    ).rows[0].output.done,
    true,
  );
});

test('retryable fetch failure retries once; a permanent fetch failure terminates without retry', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/tarball/') && ++calls === 1)
      return new Response('', { status: 404 });
    return stub(url, init);
  };
  try {
    const first = await post('retry', 'retry');
    await processScan(first.body.id);
    assert.equal(
      (await pool.query('SELECT attempt FROM scans WHERE id=$1', [first.body.id])).rows[0].attempt,
      2,
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/tarball/'))
      throw new ScanError('FETCH_FAILED', 'Permanent fixture failure', false);
    return stub(url, init);
  };
  try {
    const second = await post('permanent', 'permanent');
    const worker = await startWorker();
    try {
      await waitFor(second.body.id, 'failed');
      assert.equal(
        (await pool.query('SELECT attempt FROM scans WHERE id=$1', [second.body.id])).rows[0]
          .attempt,
        1,
      );
    } finally {
      await boss.offWork(SCAN_QUEUE, { id: worker });
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('real killed worker recovers with default heartbeat and monitor, reuses fetch checkpoint', async () => {
  const created = await post('crash-recovery', 'crash-recovery');
  const child = spawn(process.execPath, ['test/helpers/crash-worker.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: testUrl.toString(),
      SCAN_TEST_ARCHIVE: path.join(folder, 'fixture.tar'),
      ROLE: 'worker',
    },
  });
  let output = '';
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  try {
    const until = Date.now() + 12000;
    while (Date.now() < until) {
      const r = await pool.query(
        "SELECT output FROM scan_stages WHERE scan_id=$1 AND stage='fetch' AND outcome='ok'",
        [created.body.id],
      );
      if (r.rowCount) break;
      if (child.exitCode !== null) assert.fail(`crash worker exited early: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(
      (
        await pool.query("SELECT 1 FROM scan_stages WHERE scan_id=$1 AND stage='fetch'", [
          created.body.id,
        ])
      ).rowCount,
      1,
      output,
    );
    const first = (await pool.query('SELECT started_at FROM scans WHERE id=$1', [created.body.id]))
      .rows[0].started_at;
    child.kill('SIGKILL');
    await once(child, 'exit');
    const started = Date.now();
    const worker = await startWorker();
    try {
      await waitFor(created.body.id, 'completed', 60000);
      assert.ok(Date.now() - started < 60000, `recovery took ${Date.now() - started}ms`);
      const scan = (
        await pool.query('SELECT attempt,started_at FROM scans WHERE id=$1', [created.body.id])
      ).rows[0];
      assert.equal(scan.attempt, 2);
      assert.equal(scan.started_at.toISOString(), first.toISOString());
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM scan_events WHERE scan_id=$1 AND stage='fetch' AND message='fetch finished'",
            [created.body.id],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await pool.query('SELECT count(*)::int AS n FROM findings WHERE scan_id=$1', [
            created.body.id,
          ])
        ).rows[0].n,
        3,
      );
    } finally {
      await boss.offWork(SCAN_QUEUE, { id: worker });
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
});

test('three real worker crashes exhaust retries, finalize the scan and close SSE', async () => {
  const created = await post('crash-exhaustion', 'crash-exhaustion');
  const finalizer = await startFinalizer();
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const child = spawn(process.execPath, ['test/helpers/crash-worker.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: testUrl.toString(),
          SCAN_TEST_ARCHIVE: path.join(folder, 'fixture.tar'),
          ROLE: 'worker',
        },
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      try {
        const until = Date.now() + 55000;
        while (Date.now() < until) {
          const state = (
            await pool.query('SELECT attempt FROM scans WHERE id=$1', [created.body.id])
          ).rows[0];
          if (state.attempt === attempt && output.includes('"stage":"fetch"')) break;
          if (child.exitCode !== null)
            assert.fail(`worker exited before attempt ${attempt}: ${output}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.equal(
          (await pool.query('SELECT attempt FROM scans WHERE id=$1', [created.body.id])).rows[0]
            .attempt,
          attempt,
          output,
        );
        assert.match(output, /"stage":"fetch"/);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await once(child, 'exit');
        }
      }
    }
    await waitFor(created.body.id, 'failed', 60000);
    const scan = (
      await pool.query('SELECT attempt,error FROM scans WHERE id=$1', [created.body.id])
    ).rows[0];
    assert.equal(scan.attempt, 3);
    assert.equal(scan.error.code, 'SCAN_FAILED');
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM scan_events WHERE scan_id=$1 AND stage='publish'",
          [created.body.id],
        )
      ).rows[0].n,
      1,
    );
    const events = await realFetch(`${base}/api/scans/${created.body.id}/events`);
    assert.match(await events.text(), /event: end\ndata: {"status":"failed"}/);
  } finally {
    await boss.offWork(FINALIZE_QUEUE, { id: finalizer });
  }
});

test('configured worker slots execute four scans concurrently, leaving the fifth queued', async () => {
  const original = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/tarball/')) await gate;
    return stub(url, init);
  };
  let worker: string | undefined;
  try {
    const scans = await Promise.all(
      Array.from({ length: 5 }, (_, i) => post(`slots-${i}`, `slots-${i}`)),
    );
    worker = await startWorker();
    const until = Date.now() + 12000;
    let running = 0;
    while (Date.now() < until) {
      running = (await pool.query("SELECT count(*)::int AS n FROM scans WHERE status='running'"))
        .rows[0].n;
      if (running === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(running, 4);
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM scans WHERE status='queued'")).rows[0].n,
      1,
    );
    release();
    await Promise.all(scans.map((scan) => waitFor(scan.body.id, 'completed')));
  } finally {
    release();
    if (worker) await boss.offWork(SCAN_QUEUE, { id: worker });
    globalThis.fetch = original;
  }
});

test('retry-wait cancellation ends immediately without a live worker and bars further writes', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url).includes('/tarball/') ? new Response('', { status: 404 }) : stub(url, init);
  let worker: string | undefined;
  try {
    const created = await post('retry-cancel', 'retry-cancel');
    worker = await startWorker();
    const until = Date.now() + 10000;
    let state: string | undefined;
    while (Date.now() < until) {
      state = (await boss.findJobs(SCAN_QUEUE, { id: created.body.id }))[0]?.state;
      if (state === 'retry') break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(state, 'retry');
    const metrics = await (await realFetch(`${base}/api/metrics`)).json();
    assert.equal(metrics.queued, 1);
    assert.equal(metrics.running, 0);
    const queued = await (await realFetch(`${base}/api/scans/${created.body.id}`)).json();
    assert.equal(queued.status, 'queued');
    assert.equal(queued.queuePosition, 0);
    const oldLimit = config.maxQueued;
    config.maxQueued = 1;
    try {
      assert.equal((await post('overloaded', 'retry-overloaded')).status, 503);
    } finally {
      config.maxQueued = oldLimit;
    }
    await boss.offWork(SCAN_QUEUE, { id: worker });
    worker = undefined;
    const before = jobRow(
      (await pool.query('SELECT * FROM scans WHERE id=$1', [created.body.id])).rows[0],
    );
    const started = Date.now();
    assert.equal(
      (await realFetch(`${base}/api/scans/${created.body.id}/cancel`, { method: 'POST' })).status,
      202,
    );
    await waitFor(created.body.id, 'cancelled');
    assert.ok(Date.now() - started < 10000);
    assert.equal((await boss.findJobs(SCAN_QUEUE, { id: created.body.id }))[0]?.state, 'cancelled');
    assert.equal(await saveStage(before, 'fetch', { unsafe: true }, 'ok', new Date()), false);
    assert.equal(
      await tx((c) => emitEvent(c, created.body.id, before.attempt, 'fetch', 'info', 'stale')),
      false,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM scan_events WHERE scan_id=$1 AND message='stale'",
          [created.body.id],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    if (worker) await boss.offWork(SCAN_QUEUE, { id: worker });
    globalThis.fetch = original;
  }
});

test('a completed application scan is a no-op on queue redelivery', async () => {
  const created = await post('terminal-redelivery', 'terminal-redelivery');
  await pool.query(
    "UPDATE scans SET status='completed',stage='publish',report=$2,finished_at=now() WHERE id=$1",
    [created.body.id, { marker: 'before crash' }],
  );
  const worker = await startWorker();
  try {
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      if ((await boss.findJobs(SCAN_QUEUE, { id: created.body.id }))[0]?.state === 'completed')
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal((await boss.findJobs(SCAN_QUEUE, { id: created.body.id }))[0]?.state, 'completed');
    const scan = (
      await pool.query('SELECT status,attempt,report,event_seq FROM scans WHERE id=$1', [
        created.body.id,
      ])
    ).rows[0];
    assert.deepEqual(scan.report, { marker: 'before crash' });
    assert.equal(scan.attempt, 0);
    assert.equal(scan.event_seq, 1);
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM scan_stages WHERE scan_id=$1', [
          created.body.id,
        ])
      ).rows[0].n,
      0,
    );
  } finally {
    await boss.offWork(SCAN_QUEUE, { id: worker });
  }
});

test('a delayed old worker cannot displace a live replacement attempt', async () => {
  const created = await post('delayed-delivery', 'delayed-delivery');
  const held = await pool.connect();
  let worker: string | undefined;
  let locked = false;
  try {
    await held.query('BEGIN');
    locked = true;
    await held.query('SELECT id FROM scans WHERE id=$1 FOR UPDATE', [created.body.id]);
    worker = await startWorker();
    const until = Date.now() + 12000;
    let first: Awaited<ReturnType<typeof boss.findJobs>>[number] | undefined;
    while (Date.now() < until) {
      [first] = await boss.findJobs(SCAN_QUEUE, { id: created.body.id });
      if (first?.state === 'active') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(first?.state, 'active');
    assert.equal((await boss.fail(SCAN_QUEUE, first, { message: 'replaced' })).affected, 1);
    let second: Awaited<ReturnType<typeof boss.fetch>>[number] | undefined;
    const retryUntil = Date.now() + 12000;
    while (Date.now() < retryUntil) {
      [second] = await boss.fetch(SCAN_QUEUE);
      if (second) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(second);
    assert.equal(second.retryCount, 1);
    const replacement = (
      await held.query(
        "UPDATE scans SET status='running',attempt=2,started_at=now() WHERE id=$1 RETURNING started_at",
        [created.body.id],
      )
    ).rows[0].started_at;
    await held.query('COMMIT');
    locked = false;
    await boss.offWork(SCAN_QUEUE, { id: worker });
    worker = undefined;
    const row = (await pool.query('SELECT * FROM scans WHERE id=$1', [created.body.id])).rows[0];
    assert.equal(row.status, 'running');
    assert.equal(row.attempt, 2);
    assert.equal(row.started_at.toISOString(), replacement.toISOString());
    assert.equal(row.event_seq, 1);
    assert.equal(
      await saveStage(jobRow(row), 'fetch', { replacement: true }, 'ok', new Date()),
      true,
    );
  } finally {
    if (locked) await held.query('ROLLBACK');
    held.release();
    if (worker) await boss.offWork(SCAN_QUEUE, { id: worker });
  }
});

test('an expired delivery at entry retries instead of stranding its accepted scan', async () => {
  const created = await post('is', 'expired-entry');
  const held = await pool.connect();
  let worker: string | undefined;
  let locked = false;
  try {
    await held.query('BEGIN');
    locked = true;
    await held.query('SELECT id FROM scans WHERE id=$1 FOR UPDATE', [created.body.id]);
    worker = await startWorker();
    const until = Date.now() + 12000;
    let state: string | undefined;
    while (Date.now() < until) {
      state = (await boss.findJobs(SCAN_QUEUE, { id: created.body.id }))[0]?.state;
      if (state === 'active') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(state, 'active');
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'scan_test');
    assert.equal(
      (
        await pool.query(
          "UPDATE pgboss.job SET heartbeat_on=clock_timestamp()-interval '31 seconds' WHERE id=$1 AND state='active' RETURNING id",
          [created.body.id],
        )
      ).rowCount,
      1,
    );
    await held.query('COMMIT');
    locked = false;
    const settled = Date.now() + 10000;
    while (Date.now() < settled) {
      state = (await boss.findJobs(SCAN_QUEUE, { id: created.body.id }))[0]?.state;
      if (state !== 'active') break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(state, 'retry');
    assert.deepEqual(
      (await pool.query('SELECT status,attempt FROM scans WHERE id=$1', [created.body.id])).rows[0],
      { status: 'queued', attempt: 0 },
    );
    await waitFor(created.body.id, 'completed', 20000);
    assert.equal(
      (await pool.query('SELECT attempt FROM scans WHERE id=$1', [created.body.id])).rows[0]
        .attempt,
      2,
    );
  } finally {
    if (locked) await held.query('ROLLBACK');
    held.release();
    if (worker) await boss.offWork(SCAN_QUEUE, { id: worker });
  }
});

test('restarted attempt rejects old stage and progress writes; cancelling rejects both attempts', async () => {
  const created = await post('stale-retry', 'stale-retry');
  const [first] = await boss.fetch(SCAN_QUEUE);
  const old = jobRow(
    (
      await pool.query(
        "UPDATE scans SET status='running',attempt=1,started_at=now() WHERE id=$1 RETURNING *",
        [created.body.id],
      )
    ).rows[0],
  );
  assert.equal((await boss.fail(SCAN_QUEUE, first, { message: 'retry now' })).affected, 1);
  let second: typeof first | undefined;
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    [second] = await boss.fetch(SCAN_QUEUE);
    if (second) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(second);
  assert.equal(second.retryCount, 1);
  const fresh = jobRow(
    (await pool.query('UPDATE scans SET attempt=2 WHERE id=$1 RETURNING *', [created.body.id]))
      .rows[0],
  );
  assert.equal(await saveStage(old, 'fetch', { stale: true }, 'ok', new Date()), false);
  assert.equal(await tx((c) => emitEvent(c, old.id, old.attempt, 'fetch', 'info', 'stale')), false);
  assert.equal(await saveStage(fresh, 'fetch', { current: true }, 'ok', new Date()), true);
  assert.equal(
    (await realFetch(`${base}/api/scans/${created.body.id}/cancel`, { method: 'POST' })).status,
    202,
  );
  assert.equal(await saveStage(fresh, 'fetch', { unsafe: true }, 'ok', new Date()), false);
  assert.equal(
    await tx((c) => emitEvent(c, fresh.id, fresh.attempt, 'fetch', 'info', 'late')),
    false,
  );
  const row = (
    await pool.query('SELECT output FROM scan_stages WHERE scan_id=$1 AND stage=$2', [
      created.body.id,
      'fetch',
    ])
  ).rows[0];
  assert.deepEqual(row.output, { current: true });
});

test('graceful worker shutdown aborts work, cleans the workspace and redelivers', async () => {
  const created = await post('graceful', 'graceful');
  const child = spawn(process.execPath, ['test/helpers/crash-worker.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: testUrl.toString(),
      SCAN_TEST_ARCHIVE: path.join(folder, 'fixture.tar'),
      SCAN_TEST_COOPERATIVE: '1',
      ROLE: 'worker',
    },
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  try {
    const until = Date.now() + 12000;
    while (Date.now() < until) {
      if (
        (
          await pool.query("SELECT 1 FROM scan_stages WHERE scan_id=$1 AND stage='fetch'", [
            created.body.id,
          ])
        ).rowCount
      )
        break;
      if (child.exitCode !== null) assert.fail(output);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(
      (
        await pool.query("SELECT 1 FROM scan_stages WHERE scan_id=$1 AND stage='fetch'", [
          created.body.id,
        ])
      ).rowCount,
      1,
      output,
    );
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      await once(child, 'exit');
    } finally {
      clearTimeout(force);
    }
    assert.equal(child.exitCode, 0, output);
    await assert.rejects(stat(path.join(os.tmpdir(), `scan-${created.body.id}-1`)), {
      code: 'ENOENT',
    });
    const worker = await startWorker();
    try {
      await waitFor(created.body.id, 'completed', 20000);
      assert.equal(
        (await pool.query('SELECT attempt FROM scans WHERE id=$1', [created.body.id])).rows[0]
          .attempt,
        2,
      );
    } finally {
      await boss.offWork(SCAN_QUEUE, { id: worker });
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
});

test('separate API and worker processes work; failed API startup releases its resources', async () => {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  function childProcess(role: string, busyPort = port) {
    const child = spawn(process.execPath, ['src/index.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: testUrl.toString(), PORT: String(busyPort), ROLE: role },
    });
    let logs = '';
    child.stderr.on('data', (chunk: Buffer) => {
      logs += chunk.toString();
    });
    return { child, output: () => logs };
  }
  async function stopChild(child: ReturnType<typeof spawn>) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 12000);
    try {
      await once(child, 'exit');
    } finally {
      clearTimeout(force);
    }
  }
  const api = childProcess('api');
  let worker: ReturnType<typeof spawn> | undefined;
  try {
    const service = `http://127.0.0.1:${port}`;
    const ready = Date.now() + 10000;
    let healthy = false;
    while (Date.now() < ready) {
      if (api.child.exitCode !== null) assert.fail(api.output());
      try {
        healthy = (await realFetch(`${service}/api/healthz`)).ok;
      } catch {
        /* starting */
      }
      if (healthy) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(healthy, true, api.output());
    const duplicate = childProcess('api');
    const force = setTimeout(() => duplicate.child.kill('SIGKILL'), 10000);
    try {
      await once(duplicate.child, 'exit');
      assert.notEqual(duplicate.child.signalCode, 'SIGKILL', 'startup leaked connections');
      assert.notEqual(duplicate.child.exitCode, 0);
      assert.match(duplicate.output(), /EADDRINUSE/);
    } finally {
      clearTimeout(force);
      await stopChild(duplicate.child);
    }
    assert.equal((await realFetch(`${service}/api/healthz`)).status, 200);
    const scan = await post('is', 'separate-process');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      (await pool.query('SELECT status FROM scans WHERE id=$1', [scan.body.id])).rows[0].status,
      'queued',
    );
    worker = spawn(process.execPath, ['test/helpers/crash-worker.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: testUrl.toString(),
        PORT: String(port),
        ROLE: 'worker',
        SCAN_TEST_WORKER_NORMAL: '1',
        SCAN_TEST_ARCHIVE: path.join(folder, 'empty.tar'),
        OPENAI_API_KEY: '',
        TYPESAFE_API_KEY: '',
      },
    });
    let workerError = '';
    worker.stderr?.on('data', (chunk: Buffer) => {
      workerError += chunk.toString();
    });
    await waitFor(scan.body.id, 'completed', 15000);
    assert.equal((await realFetch(`${service}/api/scans/${scan.body.id}`)).status, 200);
    assert.equal((await realFetch(`${service}/api/healthz`)).status, 200, workerError);
  } finally {
    if (worker) await stopChild(worker);
    await stopChild(api.child);
  }
});

test('an expired heartbeat rejects writes before any replacement attempt begins', async () => {
  const created = await post('expired-heartbeat', 'expired-heartbeat');
  const updated = await boss.update(SCAN_QUEUE, undefined, {
    id: created.body.id,
    heartbeatSeconds: 10,
  });
  assert.equal(updated.jobs.length, 1);
  const [delivery] = await boss.fetch(SCAN_QUEUE);
  assert.equal(delivery.id, created.body.id);
  const job = jobRow(
    (
      await pool.query(
        "UPDATE scans SET status='running',attempt=1,started_at=now() WHERE id=$1 RETURNING *",
        [created.body.id],
      )
    ).rows[0],
  );
  assert.equal(await saveStage(job, 'fetch', { first: true }, 'ok', new Date()), true);
  const queued = (await boss.findJobs(SCAN_QUEUE, { id: created.body.id }))[0];
  const expired = queued.heartbeatOn!.getTime() + queued.heartbeatSeconds! * 1000;
  while (Date.now() < expired + 150) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    (await pool.query('SELECT attempt FROM scans WHERE id=$1', [job.id])).rows[0].attempt,
    1,
  );
  const eventsBefore = (
    await pool.query('SELECT count(*)::int AS n FROM scan_events WHERE scan_id=$1', [job.id])
  ).rows[0].n;
  assert.equal(await saveStage(job, 'fetch', { stale: true }, 'ok', new Date()), false);
  await assert.rejects(runJob(job));
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM scan_events WHERE scan_id=$1', [job.id]))
      .rows[0].n,
    eventsBefore,
  );
  assert.deepEqual(
    (
      await pool.query("SELECT output FROM scan_stages WHERE scan_id=$1 AND stage='fetch'", [
        job.id,
      ])
    ).rows[0].output,
    { first: true },
  );
});
