import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../../src/config.ts';
import { validateAI, explain } from '../../src/analysis/issue-explainer.ts';
import { classify, impact, jevChoice, repoType } from '../../src/analysis/context-classifier.ts';
import { buildIssues } from '../../src/reports/issue-builder.ts';
import { cweImpactMap } from '../../src/analysis/cwe-impact-map.ts';
import { impactCriteria } from '../../src/analysis/taxonomy.ts';
import type { Finding, ScanContext } from '../../src/scanners/scanner-types.ts';
const finding: Finding = {
  id: 'f',
  category: 'dependency',
  advisoryId: 'OSV-f',
  aliases: [],
  title: 'Impact advisory',
  severity: 'high',
  package: 'root',
  version: '1.0.0',
  lockfile: 'package-lock.json',
  direct: true,
  dev: false,
  introducedBy: ['root'],
  path: ['root@1.0.0'],
  fixedVersion: '1.1.0',
  cweIds: [],
  references: [],
};
const cache = { get: async <T>(_key: string) => undefined as T | undefined, set: async () => {} };
/** Minimal Responses API payload carrying `content` as the model's structured text. */
const responsesPayload = (content: unknown) =>
  Response.json({
    id: 'resp_test',
    object: 'response',
    created_at: 1234567890,
    model: 'gpt-5-mini',
    output: [
      {
        type: 'message',
        id: 'msg_test',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: JSON.stringify(content), annotations: [] }],
      },
    ],
    status: 'completed',
  });
test('AI validation rejects unknown, over-length and duplicate entries; accepts only explanation text', async () => {
  const valid = validateAI(
    {
      summary: 'summary',
      issues: [
        { issueId: 'ISS-a', whyItMatters: 'plain', command: 'rm -rf /' },
        { issueId: 'ISS-a', whyItMatters: 'duplicate' },
        { issueId: 'bad', whyItMatters: 'unknown' },
        { issueId: 'ISS-b', whyItMatters: 'x'.repeat(501) },
      ],
    },
    new Set(['ISS-a', 'ISS-b']),
  );
  assert.deepEqual(valid, {
    summary: 'summary',
    issues: [{ issueId: 'ISS-a', whyItMatters: 'plain' }],
  });
  assert.throws(() => validateAI({ summary: 'x'.repeat(801), issues: [] }, new Set()));
  const issues = await buildIssues([finding], 'library', {
    cache,
    signal: new AbortController().signal,
  });
  const before = issues[0].fix.command,
    template = issues[0].whyItMatters;
  const original = globalThis.fetch,
    old = config.openaiKey;
  config.openaiKey = 'test-key';
  const ctx = {
    workspaceDir: '',
    repo: { owner: 'a', repo: 'b', commitSha: 'a'.repeat(40) },
    signal: new AbortController().signal,
    progress: async () => {},
    cache,
  } satisfies ScanContext;
  try {
    globalThis.fetch = async () =>
      responsesPayload({
        summary: 'AI summary',
        issues: [{ issueId: 'unknown', whyItMatters: 'bad' }],
      });
    const unknown = await explain(issues, 'template', ctx);
    assert.equal(unknown.ai.used, true);
    assert.equal(issues[0].whyItMatters, template);
    globalThis.fetch = async () =>
      responsesPayload({
        summary: 'AI summary',
        issues: [{ issueId: issues[0].id, whyItMatters: 'clear', command: 'rm -rf /' }],
      });
    const good = await explain(issues, 'template', ctx);
    assert.equal(good.ai.used, true);
    assert.equal(issues[0].whyItMatters, 'clear');
    assert.equal(issues[0].fix.command, before);
    globalThis.fetch = async () => responsesPayload({ summary: 'x'.repeat(801), issues: [] });
    const bad = await explain(issues, 'template', ctx);
    assert.equal(bad.ai.used, false);
    assert.equal(bad.summary, 'template');
  } finally {
    globalThis.fetch = original;
    config.openaiKey = old;
  }
});
test('Jev requests pin the model and never retry', async () => {
  const original = globalThis.fetch,
    old = config.typesafeKey;
  config.typesafeKey = 'test-key';
  const ctx = {
    workspaceDir: '',
    repo: { owner: 'a', repo: 'b', commitSha: 'a'.repeat(40) },
    signal: new AbortController().signal,
    progress: async () => {},
    cache,
  } satisfies ScanContext;
  try {
    let calls = 0,
      model: unknown;
    globalThis.fetch = async (_url, init) => {
      calls++;
      model = (JSON.parse(String(init?.body)) as { model: unknown }).model;
      return Response.json({ answers: { answer: { choice: 'library', confidence: 0.9 } } });
    };
    await jevChoice('state', { library: 'd', cli: 'd' }, ctx);
    assert.equal(model, config.typesafeModel);
    globalThis.fetch = async () => {
      calls++;
      throw Error('Jev down');
    };
    await assert.rejects(jevChoice('other', { library: 'd', cli: 'd' }, ctx));
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
    config.typesafeKey = old;
  }
});
test('taxonomy stays in sync: every CWE-mapped bucket has Jev criteria', () => {
  const buckets = new Set([...Object.values(cweImpactMap), 'other']);
  assert.deepEqual(new Set(Object.keys(impactCriteria)), buckets);
});
test('classification rules and Jev confidence threshold / error fallback', async () => {
  assert.equal(repoType({ bin: 'cli' }), 'cli');
  assert.equal(repoType({ dependencies: { express: '^4' } }), 'web_service');
  assert.equal(repoType({ dependencies: { react: '^19' } }), 'frontend');
  assert.equal(impact({ ...finding, cweIds: ['CWE-502'] }), 'code_execution');
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'classify-'));
  await writeFile(
    path.join(workspaceDir, 'package.json'),
    JSON.stringify({ name: 'sample', dependencies: { express: '^4' } }),
  );
  const old = config.typesafeKey,
    original = globalThis.fetch;
  config.typesafeKey = 'stub';
  const ctx = {
    workspaceDir,
    repo: { owner: 'a', repo: 'b', commitSha: 'a'.repeat(40) },
    signal: new AbortController().signal,
    progress: async () => {},
    cache,
  } satisfies ScanContext;
  try {
    globalThis.fetch = async () =>
      Response.json({ answers: { answer: { choice: 'library', confidence: 0.5 } } });
    const low = await classify([{ ...finding }], ctx);
    assert.equal(low.repoType, 'web_service');
    assert.equal(low.source, 'rules');
    globalThis.fetch = async (_url, init) =>
      Response.json({
        answers: {
          answer: {
            choice: JSON.parse(String(init?.body)).state.includes('sample') ? 'library' : 'xss',
            confidence: 0.9,
          },
        },
      });
    const high = await classify([{ ...finding }], ctx);
    assert.equal(high.repoType, 'library');
    assert.equal(high.findings[0].context?.impactClass, 'xss');
    assert.equal(high.source, 'jev');
    globalThis.fetch = async () => {
      throw Error('Jev down');
    };
    const failed = await classify([{ ...finding }], ctx);
    assert.equal(failed.repoType, 'web_service');
    assert.equal(failed.findings[0].context?.source, 'rules');
    assert.ok(failed.warnings.length);
  } finally {
    globalThis.fetch = original;
    config.typesafeKey = old;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
