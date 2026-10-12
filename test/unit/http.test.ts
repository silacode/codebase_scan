import { test } from 'vitest';
import assert from 'node:assert/strict';
import { fetchWithRetry } from '../../src/integrations/http-client.ts';
test('HTTP retry handles 429, 5xx and network errors, but not other 4xx', async () => {
  const original = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return calls === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '0.01' } })
        : new Response('okay');
    };
    assert.equal(
      (await fetchWithRetry('https://api.osv.dev/v1/querybatch', {}, { timeoutMs: 1000 })).status,
      200,
    );
    assert.equal(calls, 2);
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return calls === 1
        ? new Response('', { status: 503, headers: { 'retry-after': '0.01' } })
        : new Response('okay');
    };
    assert.equal(
      (await fetchWithRetry('https://api.osv.dev/v1/querybatch', {}, { timeoutMs: 1000 })).status,
      200,
    );
    assert.equal(calls, 2);
    calls = 0;
    globalThis.fetch = async () => {
      if (++calls === 1) throw Error('temporary network error');
      return new Response('okay');
    };
    assert.equal(
      (await fetchWithRetry('https://api.osv.dev/v1/querybatch', {}, { timeoutMs: 1000 })).status,
      200,
    );
    assert.equal(calls, 2);
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response('', { status: 400 });
    };
    assert.equal(
      (await fetchWithRetry('https://api.osv.dev/v1/querybatch', {}, { timeoutMs: 1000 })).status,
      400,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test('scan abort interrupts Retry-After backoff', async () => {
  const original = globalThis.fetch,
    controller = new AbortController();
  globalThis.fetch = async () => new Response('', { status: 429, headers: { 'retry-after': '5' } });
  try {
    const started = Date.now();
    const request = fetchWithRetry(
      'https://api.osv.dev/v1/querybatch',
      {},
      { timeoutMs: 1000, signal: controller.signal },
    );
    controller.abort(Error('cancelled'));
    await assert.rejects(request, /cancelled/);
    assert.ok(Date.now() - started < 500);
  } finally {
    globalThis.fetch = original;
  }
});
