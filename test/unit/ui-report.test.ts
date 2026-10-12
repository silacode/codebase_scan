import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  associatedFindings,
  fixGroups,
  shellCommands,
} from '../../web/src/features/scans/utils/report-selectors.ts';
import { date } from '../../web/src/features/scans/utils/report-formatters.ts';
import type { Finding, Issue, Report } from '../../web/src/features/scans/types/scan-contracts.ts';
const finding = (id: string): Finding => ({
  id,
  category: 'dependency',
  package: 'pkg',
  version: '1.0.0',
  advisoryId: id,
  introducedBy: [],
  cweIds: [],
  severity: 'high',
  aliases: [],
  references: [],
  dev: false,
  direct: true,
});
const issue = (id: string, kind: Issue['fix']['kind'], findings: Finding[]): Issue => ({
  id,
  title: id,
  directDependency: 'pkg',
  otherIntroducers: [],
  priority: 1,
  problem: '',
  rootCause: '',
  fixText: '',
  whyItMatters: '',
  whySource: 'template',
  findingIds: findings.map((f) => f.id),
  findings,
  fix: {
    kind,
    effort: 'low',
    text: kind,
    command: kind === 'override' ? '{"pkg":"2.0.0"}' : undefined,
  },
});
const report = (actions: Report['actionPlan']): Report => ({
  actionPlan: actions,
  topIssues: [],
  issueCount: 7,
  verdict: { riskLevel: 'high', headline: '', summary: '' },
  stats: { severity: {}, prod: 0, dev: 0, direct: 0, transitive: 0 },
  coverage: { scanned: [], notScanned: [] },
  provenance: {
    owner: 'o',
    repo: 'r',
    ref: 'main',
    commitSha: '123',
    scannerVersion: '1',
    advisoryDataAt: '',
    scannedAt: '',
  },
  ai: { used: false },
  classifier: { source: 'rules' },
  warnings: [],
});
test('action order and all issue membership beyond five representatives, no-fix visible once', () => {
  const all = Array.from({ length: 7 }, (_, n) =>
    issue(`i${n}`, n === 6 ? 'no_fix' : 'upgrade_direct', [finding(`f${n}`)]),
  );
  const actions = [
    {
      order: 1,
      issueIds: all.slice(0, 6).map((i) => i.id),
      kind: 'upgrade_direct' as const,
      action: 'Upgrade',
      effort: 'low' as const,
      resolves: 6,
      locations: all.slice(0, 6).map((i) => ({
        issueId: i.id,
        dir: '.',
        lockfile: 'package-lock.json',
        resolves: 1,
        command: 'npm install pkg@2',
      })),
    },
  ];
  const groups = fixGroups(report(actions), all);
  assert.deepEqual(
    groups.map((group) => group.issues.map((i) => i.id)),
    [all.slice(0, 6).map((i) => i.id), ['i6']],
  );
  assert.equal(associatedFindings(groups[0].issues).length, 6);
  assert.equal(shellCommands(actions[0]).length, 6);
});
test('override JSON and manual fixes never enter shell bundle; legacy command works', () => {
  const override = issue('override', 'override', [finding('f')]);
  assert.deepEqual(
    shellCommands(
      {
        order: 1,
        issueId: 'override',
        action: 'Override',
        effort: 'low',
        resolves: 1,
        command: '{"pkg":"2.0.0"}',
      },
      [override],
    ),
    [],
  );
  assert.deepEqual(
    shellCommands(
      {
        order: 2,
        action: 'Upgrade',
        effort: 'low',
        resolves: 1,
        command: 'npm install pkg@2',
      },
      [issue('old', 'upgrade_direct', [finding('old')])],
    ),
    ['npm install pkg@2'],
  );
  assert.deepEqual(shellCommands({ order: 3, action: 'Manual', effort: 'high', resolves: 0 }), []);
});
test('unrepresented no-fix issues retain all projects and mixed severity evidence', () => {
  const low = { ...finding('low'), severity: 'low' as const, exploit: { kev: false, epss: 0 } };
  const critical = {
    ...finding('critical'),
    severity: 'critical' as const,
    exploit: { kev: false, epss: 0.2 },
  };
  const a = {
    ...issue('a', 'no_fix', [low]),
    project: { dir: 'apps/a', lockfile: 'apps/a/package-lock.json', workspaces: ['a'] },
  };
  const b = {
    ...issue('b', 'no_fix', [critical]),
    project: { dir: 'apps/b', lockfile: 'apps/b/package-lock.json', workspaces: ['b'] },
  };
  const groups = fixGroups(report([]), [a, b]);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].issues.map((item) => item.project?.dir),
    ['apps/a', 'apps/b'],
  );
  assert.deepEqual(
    associatedFindings(groups[0].issues).map((item) => item.severity),
    ['low', 'critical'],
  );
});

test('finding evidence is deduplicated and missing dates stay honest', () => {
  const shared = finding('same');
  assert.deepEqual(
    associatedFindings([issue('a', 'no_fix', [shared]), issue('b', 'no_fix', [shared])]),
    [shared],
  );
  assert.equal(date(undefined), 'Not recorded');
  assert.equal(date('not-a-date'), 'Not recorded');
});
