import { test } from 'vitest';
import assert from 'node:assert/strict';
import pg from 'pg';
import http from 'node:http';
import {
  pool,
  tx,
  emitEvent,
  boss,
  SCAN_QUEUE,
  processScan,
  testUrl,
} from '../helpers/database.ts';
import { open, close, post, base } from '../helpers/api.ts';
import { realFetch } from '../helpers/fixtures.ts';

test('same key/body replays same status/id; different body 422', async () => {
  const first = await post('nodegoat', 'one');
  const again = await post('nodegoat', 'one');
  assert.equal(first.status, 202);
  assert.equal(again.status, 202);
  assert.equal(first.body.id, again.body.id);
  assert.equal((await boss.findJobs(SCAN_QUEUE)).length, 1);
  const different = await post('other', 'one');
  assert.equal(different.status, 422);
  assert.equal(different.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('50 parallel submits race to one active row, all respond with its id (raised test-only limits)', async () => {
  const { app, url } = await open({ limits: { active: 100, submitsPerMinute: 100 } });
  try {
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) => post('race', `race-${i}`, url)),
    );
    assert.equal(new Set(responses.map((r) => r.body.id)).size, 1);
    assert.ok(responses.every((r) => [200, 202].includes(r.status)));
    assert.equal((await boss.findJobs(SCAN_QUEUE)).length, 1);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM idempotency_keys')).rows[0].n,
      50,
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM scans WHERE status='queued'")).rows[0].n,
      1,
    );
  } finally {
    await close(app);
  }
});

test('an expired idempotency key can be reused without replaying its stale status', async () => {
  const first = await post('expiry', 'expires');
  assert.equal(first.status, 202);
  await pool.query(
    "UPDATE idempotency_keys SET created_at=now()-interval '25 hours' WHERE key='expires'",
  );
  const next = await post('expiry', 'expires');
  assert.equal(next.status, 200);
  assert.equal(next.body.deduplicated, true);
  assert.equal(next.body.id, first.body.id);
  assert.equal(
    (await pool.query("SELECT status_code FROM idempotency_keys WHERE key='expires'")).rows[0]
      .status_code,
    200,
  );
});

test('each accepted scan has exactly one visible queue job', async () => {
  const first = await post('alpha', 'a');
  const second = await post('beta', 'b');
  for (const item of [first, second]) {
    const row = (await pool.query('SELECT queue_job_id FROM scans WHERE id=$1', [item.body.id]))
      .rows[0];
    assert.equal(row.queue_job_id, item.body.id);
    assert.equal((await boss.findJobs(SCAN_QUEUE, { id: item.body.id })).length, 1);
  }
});

test('SSE Last-Event-ID replays only newer events then end', async () => {
  const created = await post('sse', 'sse');
  await tx((c) => emitEvent(c, created.body.id, null, 'fetch', 'info', 'new'));
  assert.equal(
    (await fetch(`${base}/api/scans/${created.body.id}/cancel`, { method: 'POST' })).status,
    202,
  );
  const response = await realFetch(`${base}/api/scans/${created.body.id}/events`, {
    headers: { 'Last-Event-ID': '1' },
  });
  const data = await response.text();
  assert.ok(!data.includes('id: 1\n'));
  assert.ok(data.includes('id: 2\n'));
  assert.ok(data.includes('event: end'));
});

test('SSE catches up after terminating its LISTEN backend', async () => {
  const created = await post('listener-reconnect', 'listener-reconnect');
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 7000);
  try {
    const response = await realFetch(`${base}/api/scans/${created.body.id}/events`, {
      headers: { 'Last-Event-ID': '1' },
      signal: abort.signal,
    });
    const reader = response.body!.getReader();
    const listeners =
      await pool.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
      AND query ILIKE 'LISTEN%' AND pid <> pg_backend_pid()`);
    assert.ok(listeners.rowCount, 'API LISTEN connection should be active');
    await pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database()
      AND query ILIKE 'LISTEN%' AND pid <> pg_backend_pid()`);
    await tx((c) => emitEvent(c, created.body.id, null, 'fetch', 'info', 'after listener drop'));
    let received = '';
    while (!received.includes('after listener drop')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, 'SSE closed before receiving the event');
      received += new TextDecoder().decode(chunk.value);
    }
    assert.match(received, /id: 2\n/);
    await reader.cancel();
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
});

test('idle Postgres connection failures do not crash the API', async () => {
  await pool.query('SELECT 1');
  const killer = new pg.Client({ connectionString: testUrl.toString() });
  await killer.connect();
  try {
    const result = await killer.query(`SELECT pg_terminate_backend(pid) AS terminated
      FROM pg_stat_activity WHERE datname=current_database() AND state='idle'
      AND pid <> pg_backend_pid()`);
    assert.ok(
      result.rows.some((row) => row.terminated),
      'at least one idle backend was terminated',
    );
  } finally {
    await killer.end();
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  const health = await realFetch(`${base}/api/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, db: true });
});

test('queued cancellation is terminal; per-IP default rejects the fourth active scan', async () => {
  const { app, url } = await open();
  try {
    const created = await post('cancel', 'cancel', url);
    const response = await fetch(`${url}/api/scans/${created.body.id}/cancel`, { method: 'POST' });
    assert.equal(response.status, 202);
    assert.equal(
      (await pool.query('SELECT status FROM scans WHERE id=$1', [created.body.id])).rows[0].status,
      'cancelled',
    );
    for (let i = 0; i < 3; i++)
      assert.equal((await post(`active-${i}`, `limit-${i}`, url)).status, 202);
    const fourth = await post('active-3', 'limit-3', url);
    assert.equal(fourth.status, 429);
    assert.equal(fourth.body.error.code, 'TOO_MANY_ACTIVE_SCANS');
  } finally {
    await close(app);
  }
});

test('cached scans and idempotency replays never create another queue job', async () => {
  const created = await post('cache-hit', 'cache-original');
  const replay = await post('cache-hit', 'cache-original');
  assert.equal(replay.body.id, created.body.id);
  assert.equal((await boss.findJobs(SCAN_QUEUE)).length, 1);
  await processScan(created.body.id);
  const cached = await post('cache-hit', 'cache-second');
  assert.equal(cached.status, 200);
  assert.equal(cached.body.cached, true);
  assert.equal(cached.body.id, created.body.id);
  assert.equal((await boss.findJobs(SCAN_QUEUE)).length, 1);
  const cachedReplay = await post('cache-hit', 'cache-second');
  assert.equal(cachedReplay.status, 200);
  assert.equal((await boss.findJobs(SCAN_QUEUE)).length, 1);
});

test('invalid submissions and API paths return bounded JSON errors; navigation stays in the SPA', async () => {
  const { createApi } = await import('../../src/app.ts');
  const app = await createApi();
  try {
    const request = (body: string, headers = { 'content-type': 'application/json' }) =>
      app.inject({ method: 'POST', url: '/api/scans', headers, payload: body });
    for (const [body, headers, status, code] of [
      ['{', { 'content-type': 'application/json' }, 400, 'INVALID_BODY'],
      ['{}', { 'content-type': 'text/plain' }, 400, 'INVALID_BODY'],
      ['{}', { 'content-type': 'application/json' }, 400, 'INVALID_URL'],
      ['{"repoUrl":42}', { 'content-type': 'application/json' }, 400, 'INVALID_URL'],
      [
        '{"repoUrl":"https://github.com/test/is","force":"true"}',
        { 'content-type': 'application/json' },
        400,
        'INVALID_URL',
      ],
      ['[]', { 'content-type': 'application/json' }, 400, 'INVALID_BODY'],
      [
        '{"repoUrl":"https://github.com/test/is"}'.padEnd(16385, ' '),
        { 'content-type': 'application/json' },
        413,
        'BODY_TOO_LARGE',
      ],
    ] as const) {
      const response = await request(body, headers);
      assert.equal(response.statusCode, status, body.slice(0, 80));
      assert.equal(response.json().error.code, code);
      assert.equal(typeof response.json().error.retryable, 'boolean');
    }
    for (const [url, code] of [
      ['/api/scans/not-a-uuid', 'INVALID_ID'],
      [
        '/api/scans/00000000-0000-0000-0000-000000000001/findings?severity=unknown',
        'INVALID_FILTER',
      ],
      ['/api/scans/00000000-0000-0000-0000-000000000001/findings?offset=1.2', 'INVALID_FILTER'],
      ['/api/missing', 'NOT_FOUND'],
    ]) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, code === 'NOT_FOUND' ? 404 : 400);
      assert.equal(response.json().error.code, code);
    }
    const home = await app.inject('/');
    assert.equal(home.statusCode, 200);
    assert.match(home.headers['content-type'] ?? '', /text\/html/);
    assert.equal((await app.inject({ method: 'HEAD', url: '/' })).statusCode, 200);
    const asset = home.body.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
    assert.ok(asset, 'the served page references a built asset');
    assert.equal((await app.inject(asset)).statusCode, 200);
    assert.match((await app.inject('/some/report')).headers['content-type'] ?? '', /text\/html/);
    assert.match((await app.inject('/some%20report')).headers['content-type'] ?? '', /text\/html/);
    assert.equal((await app.inject('/missing.js')).statusCode, 404);
    for (const url of ['/.env', '/%2eenv']) {
      const response = await app.inject(url);
      assert.equal(response.statusCode, 404, url);
      assert.equal(response.json().error.code, 'NOT_FOUND');
    }
    for (const path of ['/%2e%2e/.env', '/%2e%2e/README', '/x%2F..%2FREADME']) {
      const response = await new Promise<{ statusCode?: number; body: string }>(
        (resolve, reject) => {
          const request = http.get(
            { hostname: '127.0.0.1', port: Number(new URL(base).port), path },
            (response) => {
              const chunks: Buffer[] = [];
              response.on('data', (chunk: Buffer) => chunks.push(chunk));
              response.on('end', () =>
                resolve({
                  statusCode: response.statusCode,
                  body: Buffer.concat(chunks).toString(),
                }),
              );
              response.on('error', reject);
            },
          );
          request.on('error', reject);
        },
      );
      assert.equal(response.statusCode, 404, path);
      assert.equal(JSON.parse(response.body).error.code, 'NOT_FOUND');
    }
    const malformed = await app.inject('/%E0%A4%A');
    assert.ok(malformed.statusCode >= 400 && malformed.statusCode < 500);
    const created = await post('is', 'invalid-event-id');
    const eventError = await app.inject(`/api/scans/${created.body.id}/events?lastEventId=-1`);
    assert.equal(eventError.statusCode, 400);
    assert.equal(eventError.json().error.code, 'INVALID_EVENT_ID');
  } finally {
    await app.close();
  }
});

test('closing an API instance ends its active SSE streams without waiting for a scan', async () => {
  const created = await post('sse-shutdown', 'sse-shutdown');
  const { app, url } = await open();
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await realFetch(`${url}/api/scans/${created.body.id}/events`, {
      signal: abort.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    assert.equal((await reader.read()).done, false);
    await Promise.race([
      close(app),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('SSE shutdown hung')), 3000);
      }),
    ]);
    let done = false;
    while (!done) ({ done } = await reader.read());
  } finally {
    clearTimeout(timer);
    abort.abort();
    if (app.server.listening) await app.close();
  }
});
