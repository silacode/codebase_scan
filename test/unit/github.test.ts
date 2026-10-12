import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseRepoUrl, resolveRepo } from '../../src/integrations/github-repository.ts';
test('valid GitHub URL variants', () => {
  for (const value of [
    'https://github.com/A/B',
    'https://github.com/A/B.git/',
    'http://www.github.com/A/B/',
  ])
    assert.deepEqual(parseRepoUrl(value), { owner: 'A', repo: 'B' });
  assert.deepEqual(parseRepoUrl('https://github.com/A/B/tree/feature/x'), {
    owner: 'A',
    repo: 'B',
    ref: 'feature/x',
  });
});
test('malformed GitHub metadata fails closed before queuing', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ private: 'no', size: 'huge', default_branch: null });
  try {
    await assert.rejects(resolveRepo('owner', 'repo'), { code: 'GITHUB_UNAVAILABLE' });
  } finally {
    globalThis.fetch = original;
  }
});
test('invalid hosts, paths, owners, refs, and SSRF-looking input', () => {
  for (const value of [
    'https://github.com.evil.com/a/b',
    'https://evil.com/github.com/a/b',
    'file:///etc',
    'https://gitlab.com/a/b',
    'https://github.com/-bad/repo',
    'https://github.com/a/..',
    'https://github.com/a/b/issues',
    'https://github.com/a/b/tree/../x',
    'https://github.com/a/b/tree/-bad',
    'https://github.com/a/b?url=https://evil.com',
    'https://user:pass@github.com/a/b',
  ]) {
    assert.throws(() => parseRepoUrl(value), { code: 'INVALID_URL' }, value);
  }
});
