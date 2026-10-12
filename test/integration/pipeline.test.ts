import { test } from 'vitest';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as tar from 'tar';
import {
  pool,
  boss,
  SCAN_QUEUE,
  FINALIZE_QUEUE,
  startWorker,
  startFinalizer,
  waitFor,
  processScan,
} from '../helpers/database.ts';
import { post, base } from '../helpers/api.ts';
import { stub, sha, folder } from '../helpers/fixtures.ts';

test('full stubbed pipeline completes, stores Issues/findings, reports AI fallback and provenance', async () => {
  const created = await post('nodegoat', 'pipeline');
  await processScan(created.body.id);
  const s = await (await fetch(`${base}/api/scans/${created.body.id}`)).json();
  assert.equal(s.status, 'completed', JSON.stringify(s.error));
  assert.ok(s.report.issueCount >= 1);
  assert.equal(s.report.ai.used, false);
  assert.equal(s.report.provenance.commitSha, sha('nodegoat'));
  assert.ok(s.report.topIssues.some((i: { fix: { command?: string } }) => i.fix.command));
  assert.ok((await pool.query('SELECT 1 FROM issues')).rowCount);
  assert.ok((await pool.query('SELECT 1 FROM findings')).rowCount);
  const findings = await (await fetch(`${base}/api/scans/${s.id}/findings?limit=10`)).json();
  assert.ok(findings.total >= 2);
});

test('malformed OSV advisory data fails the scan instead of publishing a clean report', async () => {
  const original = globalThis.fetch;
  const finalizer = await startFinalizer();
  const worker = await startWorker();
  globalThis.fetch = async (url, init) =>
    String(url).includes('api.osv.dev/v1/vulns/')
      ? Response.json({ id: 'GHSA-TEST', aliases: null })
      : stub(url, init);
  try {
    const created = await post('invalid-advisory', 'invalid-advisory');
    await waitFor(created.body.id, 'failed', 30000);
    const scan = await (await fetch(`${base}/api/scans/${created.body.id}`)).json();
    assert.equal(scan.error.code, 'SCAN_FAILED');
    assert.equal(scan.report, null);
  } finally {
    await boss.offWork(SCAN_QUEUE, { id: worker });
    await boss.offWork(FINALIZE_QUEUE, { id: finalizer });
    globalThis.fetch = original;
  }
});

test('independent projects share an action step with root-runnable commands', async () => {
  const created = await post('monorepo', 'monorepo');
  await processScan(created.body.id);
  const scan = await (await fetch(`${base}/api/scans/${created.body.id}`)).json();
  assert.equal(scan.status, 'completed', JSON.stringify(scan.error));
  assert.equal(scan.report.actionPlan.length, 1);
  const [step] = scan.report.actionPlan;
  assert.equal(step.locations.length, 2);
  assert.deepEqual(
    new Set(step.locations.map((l: { command: string }) => l.command)),
    new Set(['npm install parent@1.1.0', 'npm --prefix packages/web install parent@1.1.0']),
  );
});

test('a lockfile above 20 MB is skipped and named in the report coverage', async () => {
  const dir = path.join(folder, 'oversize-source');
  await mkdir(dir);
  await writeFile(path.join(dir, 'package-lock.json'), Buffer.alloc(20 * 1024 * 1024 + 1));
  const file = path.join(folder, 'oversize.tar');
  await tar.c({ cwd: folder, file }, [path.basename(dir)]);
  const bytes = await readFile(file),
    original = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url).includes('/tarball/') ? new Response(Uint8Array.from(bytes)) : stub(url, init);
  try {
    const created = await post('oversize', 'oversize');
    await processScan(created.body.id);
    const s = await (await fetch(`${base}/api/scans/${created.body.id}`)).json();
    assert.equal(s.status, 'completed');
    assert.equal(s.report.verdict.riskLevel, 'clean');
    assert.ok(
      s.report.coverage.notScanned.some(
        (gap: { what: string; why: string }) =>
          gap.what === 'package-lock.json' && gap.why.includes('20 MB'),
      ),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('optional enrichment failure yields partial stage, warning and coverage gap, not a failed scan', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url).includes('www.cisa.gov') ? new Response('', { status: 400 }) : stub(url, init);
  try {
    const created = await post('degraded', 'degraded');
    await processScan(created.body.id);
    const s = await (await fetch(`${base}/api/scans/${created.body.id}`)).json();
    assert.equal(s.status, 'completed');
    assert.ok(s.report.warnings.some((warning: string) => warning.includes('KEV')));
    assert.ok(
      s.report.coverage.notScanned.some((gap: { what: string }) => gap.what === 'CISA KEV'),
    );
    assert.equal(
      (
        await pool.query("SELECT outcome FROM scan_stages WHERE scan_id=$1 AND stage='enrich'", [
          created.body.id,
        ])
      ).rows[0].outcome,
      'partial',
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('spent original deadline is terminal, or publishes saved dependency results as partial', async () => {
  const expired = await post('deadline-no-checkpoint', 'deadline-no-checkpoint');
  await pool.query("UPDATE scans SET started_at=now()-interval '301 seconds' WHERE id=$1", [
    expired.body.id,
  ]);
  const worker = await startWorker();
  try {
    await waitFor(expired.body.id, 'failed');
    const row = (await pool.query('SELECT attempt,error FROM scans WHERE id=$1', [expired.body.id]))
      .rows[0];
    assert.equal(row.attempt, 1);
    assert.equal(row.error.code, 'TIMEOUT');
  } finally {
    await boss.offWork(SCAN_QUEUE, { id: worker });
  }
  await assert.rejects(stat(path.join(os.tmpdir(), `scan-${expired.body.id}-1`)), {
    code: 'ENOENT',
  });

  const partial = await post('deadline-checkpoint', 'deadline-checkpoint');
  await pool.query("UPDATE scans SET started_at=now()-interval '301 seconds' WHERE id=$1", [
    partial.body.id,
  ]);
  await pool.query(
    `INSERT INTO scan_stages(scan_id,stage,output,outcome) VALUES($1,'scan_dependencies',$2,'ok')`,
    [
      partial.body.id,
      {
        findings: [],
        coverage: { scanned: ['package-lock.json'], notScanned: [] },
        stats: { packages: 0, lockfiles: 1 },
      },
    ],
  );
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/tarball/')) throw new Error('completed checkpoint must not fetch');
    return stub(url, init);
  };
  const secondWorker = await startWorker();
  try {
    await waitFor(partial.body.id, 'completed');
    const row = (
      await pool.query('SELECT attempt,started_at,report FROM scans WHERE id=$1', [partial.body.id])
    ).rows[0];
    assert.equal(row.attempt, 1);
    assert.ok(Date.now() - row.started_at.getTime() > 300000);
    assert.ok(row.report.warnings.includes('Scan deadline reached; later stages incomplete'));
    assert.ok(
      row.report.coverage.notScanned.some(
        (gap: { why: string }) => gap.why === 'scan deadline exceeded',
      ),
    );
  } finally {
    await boss.offWork(SCAN_QUEUE, { id: secondWorker });
    globalThis.fetch = original;
  }
  await assert.rejects(stat(path.join(os.tmpdir(), `scan-${partial.body.id}-1`)), {
    code: 'ENOENT',
  });
});
