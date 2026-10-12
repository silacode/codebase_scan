import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildIssues } from '../../src/reports/issue-builder.ts';
import { enrich } from '../../src/analysis/finding-enrichment.ts';
import { fixIssue, isNpmName, shellArg } from '../../src/reports/remediation-planner.ts';
import { score } from '../../src/reports/issue-scoring.ts';
import { verdict, buildReport } from '../../src/reports/report-builder.ts';
import type { Finding } from '../../src/scanners/scanner-types.ts';
const f = (extra: Partial<Finding> = {}): Finding => ({
  id: 'one',
  category: 'dependency',
  advisoryId: 'GHSA-a',
  aliases: [],
  title: 'advisory',
  severity: 'high',
  package: 'parent',
  version: '1.0.0',
  lockfile: 'package-lock.json',
  direct: true,
  dev: false,
  introducedBy: ['parent'],
  path: ['parent@1.0.0'],
  fixedVersion: '1.2.0',
  cweIds: ['CWE-400'],
  references: [],
  context: { impactClass: 'denial_of_service', source: 'rules' },
  exploit: { kev: false, epss: 0 },
  ...extra,
});
const cache = { get: async <T>(_key: string) => undefined as T | undefined, set: async () => {} };
const ctx = { cache, signal: new AbortController().signal };
test('all four fixes, target and effort', async () => {
  assert.deepEqual((await fixIssue([f()], 'parent', ctx)).kind, 'upgrade_direct');
  assert.equal(
    (
      await fixIssue(
        [f({ version: '0.1.0', path: ['parent@0.1.0'], fixedVersion: '0.2.0' })],
        'parent',
        ctx,
      )
    ).effort,
    'medium',
  );
  const child = f({
    package: 'child',
    version: '1.1.0',
    direct: false,
    path: ['parent@1.0.0', 'child@1.1.0'],
    parent: { name: 'parent', range: '^1.0.0' },
    fixedVersion: '1.2.0',
  });
  assert.equal((await fixIssue([child], 'parent', ctx)).command, 'npm update child');
  assert.equal((await fixIssue([f({ fixedVersion: undefined })], 'parent', ctx)).kind, 'no_fix');
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /^https:\/\/registry\.npmjs\.org\/parent/);
    return Response.json({
      'dist-tags': { latest: '3.0.0' },
      versions: {
        '1.0.0': { dependencies: { child: '^1.0.0' } },
        '1.2.0': { dependencies: { child: '^2.0.0' } },
        '1.3.0': { dependencies: { child: '^2.0.0' } },
        '3.0.0': { dependencies: { child: '^2.0.0' } },
      },
    });
  };
  try {
    const fix = await fixIssue([{ ...child, fixedVersion: '2.0.0' }], 'parent', ctx);
    assert.equal(fix.kind, 'upgrade_parent');
    assert.equal(fix.target, '1.2.0');
    assert.equal(fix.effort, 'low');
  } finally {
    globalThis.fetch = original;
  }
});
test('old, unchanged, or prerelease latest yields overrides instead of unsafe upgrades', async () => {
  const original = globalThis.fetch;
  const deeper = f({
    package: 'nested',
    direct: false,
    version: '1.0.0',
    fixedVersion: '3.0.0',
    introducedBy: ['parent'],
    path: ['parent@0.2.0', 'middle@1.0.0', 'nested@1.0.0'],
    parent: { name: 'middle', range: '^1.0.0' },
  });
  try {
    for (const latest of ['0.1.5', '0.2.0', '0.3.0-rc.7']) {
      globalThis.fetch = async () =>
        Response.json({
          'dist-tags': { latest },
          versions: { [latest]: { dependencies: {} } },
        });
      const fix = await fixIssue([deeper], 'parent', ctx);
      assert.equal(fix.kind, 'override', latest);
      assert.equal(fix.target, undefined);
      assert.equal(fix.effort, 'high');
      assert.deepEqual(JSON.parse(fix.command!), { overrides: { nested: '^3.0.0' } });
    }
  } finally {
    globalThis.fetch = original;
  }
});
test('deep-only Issues use newer stable latest, but constrained Issues never bypass their checks', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      'dist-tags': { latest: '2.0.0' },
      versions: { '2.0.0': { dependencies: { child: '^1.0.0' } } },
    });
  try {
    const deeper = f({
      package: 'nested',
      direct: false,
      fixedVersion: '3.0.0',
      path: ['parent@1.0.0', 'middle@1.0.0', 'nested@1.0.0'],
    });
    const latest = await fixIssue([deeper], 'parent', ctx);
    assert.equal(latest.target, '2.0.0');
    assert.match(latest.note!, /Verify/);
    const child = f({
      package: 'child',
      direct: false,
      fixedVersion: '3.0.0',
      path: ['parent@1.0.0', 'child@1.0.0'],
      parent: { name: 'parent', range: '^1.0.0' },
    });
    const constrained = await fixIssue([child], 'parent', ctx);
    assert.equal(constrained.kind, 'override');
    assert.deepEqual(JSON.parse(constrained.command!), { overrides: { child: '^3.0.0' } });
  } finally {
    globalThis.fetch = original;
  }
});
test('removing a vulnerable immediate child qualifies the lowest newer release', async () => {
  const original = globalThis.fetch;
  const nconf = f({
    id: 'nconf',
    package: 'nconf',
    version: '0.10.0',
    direct: false,
    path: ['forever@2.0.0', 'nconf@0.10.0'],
    introducedBy: ['forever'],
    parent: { name: 'forever', range: '^0.10.0' },
    fixedVersion: '0.11.4',
  });
  const deeper = f({
    id: 'deep',
    package: 'deep',
    direct: false,
    fixedVersion: '2.0.0',
    path: ['forever@2.0.0', 'middle@1.0.0', 'deep@1.0.0'],
    introducedBy: ['forever'],
  });
  try {
    globalThis.fetch = async () =>
      Response.json({
        'dist-tags': { latest: '4.0.3' },
        versions: {
          '3.0.0': { dependencies: { nconf: '^0.10.0' } },
          '4.0.0': { dependencies: {} },
          '4.0.1': { optionalDependencies: { nconf: '^0.10.0' } },
          '4.0.2': { peerDependencies: { nconf: '^0.10.0' } },
          '4.0.3': {},
        },
      });
    const fix = await fixIssue([nconf, deeper], 'forever', ctx);
    assert.equal(fix.kind, 'upgrade_parent');
    assert.equal(fix.from, '2.0.0');
    assert.equal(fix.target, '4.0.0');
    assert.equal(fix.effort, 'high');
    assert.match(fix.note!, /Verify the vulnerable versions are gone/);

    globalThis.fetch = async () =>
      Response.json({
        'dist-tags': { latest: '4.0.3' },
        versions: {
          '4.0.1': { optionalDependencies: { nconf: '^0.10.0' } },
          '4.0.2': { peerDependencies: { nconf: '^0.10.0' } },
          '4.0.3': {},
        },
      });
    assert.equal((await fixIssue([nconf], 'forever', ctx)).target, '4.0.3');
  } finally {
    globalThis.fetch = original;
  }
});
test('registry candidates honor own and immediate-child fixes before major releases', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      'dist-tags': { latest: '5.3.0' },
      versions: {
        '4.19.0': { dependencies: { child: '^2.0.0' } },
        '4.20.0': { dependencies: { child: '^2.0.0' } },
        '4.21.0': { dependencies: { child: '^2.0.0' } },
        '5.3.0': { dependencies: { child: '^2.0.0' } },
      },
    });
  const own = f({
    package: 'express',
    path: ['express@4.18.0'],
    version: '4.18.0',
    fixedVersion: '4.20.0',
  });
  const child = f({
    package: 'child',
    direct: false,
    path: ['express@4.18.0', 'child@1.0.0'],
    introducedBy: ['express'],
    fixedVersion: '2.0.0',
    parent: { name: 'express', range: '^1.0.0' },
  });
  try {
    const fix = await fixIssue([own, child], 'express', ctx);
    assert.equal(fix.kind, 'upgrade_parent');
    assert.equal(fix.from, '4.18.0');
    assert.equal(fix.target, '4.20.0');
    assert.equal(fix.note, undefined);
  } finally {
    globalThis.fetch = original;
  }
});
test('own fix plus deeper children chooses earliest qualifying release with a verify note', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      'dist-tags': { latest: '7.7.0' },
      versions: { '3.1.12': {}, '3.1.13': {}, '7.7.0': {} },
    });
  const own = f({
    package: 'mongodb',
    version: '2.2.36',
    path: ['mongodb@2.2.36'],
    fixedVersion: '3.1.13',
  });
  const child = f({
    package: 'nested',
    direct: false,
    fixedVersion: '4.0.0',
    introducedBy: ['mongodb'],
    path: ['mongodb@2.2.36', 'middle@1.0.0', 'nested@1.0.0'],
  });
  try {
    const fix = await fixIssue([own, child], 'mongodb', ctx);
    assert.equal(fix.kind, 'upgrade_parent');
    assert.equal(fix.from, '2.2.36');
    assert.equal(fix.target, '3.1.13');
    assert.match(fix.note!, /Verify the vulnerable versions are gone/);
  } finally {
    globalThis.fetch = original;
  }
});
test('a bounded volume bonus keeps 56 dev critical findings below one prod critical', async () => {
  const dev = Array.from({ length: 56 }, (_, i) =>
    f({
      id: `dev-${i}`,
      package: 'devtool',
      dev: true,
      severity: 'critical',
      path: ['devtool@1.0.0'],
      introducedBy: ['devtool'],
    }),
  );
  const prod = f({
    id: 'prod',
    package: 'production',
    severity: 'critical',
    path: ['production@1.0.0'],
    introducedBy: ['production'],
  });
  const issues = await buildIssues([...dev, prod], 'web_service', ctx);
  assert.equal(issues[0].directDependency, 'production');
  assert.ok(issues[0].priority > issues[1].priority);
  assert.equal(issues[1].priority, score(dev[0], 'web_service') * 1.5);
});
test('mixed fixes keep a command and count only fixable findings in the action plan', async () => {
  const mixed = [
    f(),
    f({
      id: 'unfixed',
      package: 'child',
      direct: false,
      dev: false,
      introducerDev: false,
      introducedBy: ['parent'],
      path: ['parent@1.0.0', 'child@1.0.0'],
      fixedVersion: undefined,
    }),
  ];
  const issues = await buildIssues(mixed, 'library', ctx);
  assert.equal(issues[0].fix.kind, 'upgrade_direct');
  assert.equal(issues[0].fix.command, 'npm install parent@1.2.0');
  assert.equal(issues[0].fix.fixableCount, 1);
  assert.equal(issues[0].fix.unfixableCount, 1);
  assert.match(issues[0].fixText, /1 finding has no fixed version yet \(child\)/);
  assert.match(issues[0].whyItMatters, /production dependency/);
  const report = buildReport({
    findings: mixed,
    issues,
    repoType: 'library',
    coverage: { scanned: [], notScanned: [] },
    stats: {},
    repo: { owner: 'a', repo: 'b', ref: 'main', commitSha: 'a'.repeat(40) },
    advisoryDataAt: '2020-01-01',
    warnings: [],
    ai: { used: false },
    classifier: { source: 'rules' },
  });
  assert.equal(report.actionPlan[0].resolves, 1);
  assert.equal(
    (
      await fixIssue(
        mixed.map((item) => ({ ...item, fixedVersion: undefined })),
        'parent',
        ctx,
      )
    ).kind,
    'no_fix',
  );
});
test('problem and root cause cap package lists at five', async () => {
  const findings = Array.from({ length: 7 }, (_, i) =>
    f({
      id: String(i),
      package: `pkg${i}`,
      direct: false,
      introducedBy: ['parent'],
      path: ['parent@1.0.0', `pkg${i}@1.0.0`],
      parent: { name: 'parent', range: '^1.0.0' },
    }),
  );
  const [issue] = await buildIssues(findings, 'library', ctx);
  assert.match(issue.problem, /and 2 more/);
  assert.match(issue.rootCause, /and 2 more/);
  assert.ok(!issue.problem.includes('pkg6'));
});
test('monorepo groups identical installs and retains per-project commands and counts', async () => {
  const findings = [
    f({
      id: 'root',
      package: 'next',
      version: '15.0.0',
      path: ['next@15.0.0'],
      introducedBy: ['next'],
      fixedVersion: '16.3.8',
    }),
    f({
      id: 'a',
      package: 'next',
      lockfile: 'apps/a/package-lock.json',
      version: '15.0.0',
      path: ['next@15.0.0'],
      introducedBy: ['next'],
      fixedVersion: '16.3.8',
    }),
    f({
      id: 'b',
      package: 'next',
      lockfile: 'apps/b c/package-lock.json',
      version: '15.0.0',
      path: ['next@15.0.0'],
      introducedBy: ['next'],
      fixedVersion: '16.3.8',
      severity: 'critical',
    }),
  ];
  const issues = await buildIssues(findings, 'library', ctx);
  const report = buildReport({
    findings,
    issues,
    repoType: 'library',
    coverage: { scanned: [], notScanned: [] },
    stats: {},
    repo: { owner: 'a', repo: 'b', ref: 'main', commitSha: 'a'.repeat(40) },
    advisoryDataAt: '2020-01-01',
    warnings: [],
    ai: { used: false },
    classifier: { source: 'rules' },
  });
  assert.equal(report.actionPlan.length, 1);
  const [step] = report.actionPlan;
  assert.equal(step.resolves, 3);
  assert.equal(step.effort, 'high');
  assert.equal(step.locations.length, 3);
  assert.deepEqual(
    new Set(step.locations.map((l) => l.command)),
    new Set([
      'npm install next@16.3.8',
      'npm --prefix apps/a install next@16.3.8',
      "npm --prefix 'apps/b c' install next@16.3.8",
    ]),
  );
  assert.equal(report.topIssues.length, 1);
  assert.equal(report.topIssues[0].alsoIn.length, 2);
  assert.match(report.verdict.headline, /1 distinct fix in 3 projects/);
  assert.equal(
    new Set(report.actionPlan.map((a) => `${a.kind}|${a.baseCommand}`)).size,
    report.actionPlan.length,
  );
});
test('verdict uses singular and plural fix, project, and finding labels', async () => {
  const first = f();
  const second = f({
    id: 'other',
    package: 'other',
    introducedBy: ['other'],
    path: ['other@1.0.0'],
    lockfile: 'apps/a/package-lock.json',
  });
  const one = verdict([first], await buildIssues([first], 'library', ctx));
  assert.match(one.headline, /1 distinct fix in 1 project,/);
  assert.match(one.summary, /1 finding in 1 issue across 1 project/);
  const many = verdict([first, second], await buildIssues([first, second], 'library', ctx));
  assert.match(many.headline, /2 distinct fixes in 2 projects,/);
  assert.match(many.summary, /2 findings in 2 issues across 2 projects/);
});
test('shell quoting and npm name validation prevent unsafe copyable commands', async () => {
  assert.equal(shellArg("x'$(touch pwned)"), "'x'\\''$(touch pwned)'");
  assert.equal(isNpmName('@scope/valid.name'), true);
  assert.equal(isNpmName('evil;rm -rf ~'), false);
  assert.equal(isNpmName('a'.repeat(215)), false);
  const findings = [
    f({
      id: 'safe',
      package: 'next',
      introducedBy: ['next'],
      path: ['next@1.0.0'],
      lockfile: 'x$(touch pwned)/package-lock.json',
    }),
    f({
      id: 'unsafe',
      package: 'evil;rm -rf ~',
      introducedBy: ['evil;rm -rf ~'],
      path: ['evil;rm -rf ~@1.0.0'],
    }),
  ];
  const issues = await buildIssues(findings, 'library', ctx);
  assert.equal(
    issues.find((i) => i.directDependency === 'next')?.fix.command,
    "npm --prefix 'x$(touch pwned)' install next@1.2.0",
  );
  assert.equal(issues.find((i) => i.directDependency === 'evil;rm -rf ~')?.fix.command, undefined);
});
test('overrides name the project package.json', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ 'dist-tags': { latest: '1.0.0' }, versions: {} });
  try {
    const [issue] = await buildIssues(
      [
        f({
          package: 'nested',
          direct: false,
          lockfile: 'apps/a/package-lock.json',
          introducedBy: ['parent'],
          path: ['parent@1.0.0', 'middle@1.0.0', 'nested@1.0.0'],
        }),
      ],
      'library',
      ctx,
    );
    assert.equal(issue.fix.kind, 'override');
    assert.equal(issue.fix.applyTo, 'apps/a/package.json');
    assert.match(issue.fix.text, /apps\/a\/package.json/);
  } finally {
    globalThis.fetch = original;
  }
});
test('different override snippets remain separate action steps', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ 'dist-tags': { latest: '1.0.0' }, versions: {} });
  try {
    const findings = ['left', 'right'].map((name) =>
      f({
        id: name,
        package: name,
        direct: false,
        introducedBy: ['parent'],
        path: ['parent@1.0.0', 'middle@1.0.0', `${name}@1.0.0`],
        lockfile: `${name}/package-lock.json`,
      }),
    );
    const issues = await buildIssues(findings, 'library', ctx);
    const report = buildReport({
      findings,
      issues,
      repoType: 'library',
      coverage: { scanned: [], notScanned: [] },
      stats: {},
      repo: { owner: 'a', repo: 'b', ref: 'main', commitSha: 'a'.repeat(40) },
      advisoryDataAt: '2020-01-01',
      warnings: [],
      ai: { used: false },
      classifier: { source: 'rules' },
    });
    assert.equal(report.actionPlan.length, 2);
    assert.equal(
      new Set(report.actionPlan.map((a) => `${a.kind}|${a.baseCommand}`)).size,
      report.actionPlan.length,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test('reports distinguish unavailable exploit data from checked negatives and genuine zero EPSS', async () => {
  const original = globalThis.fetch;
  const context = {
    ...ctx,
    workspaceDir: '',
    progress: async () => {},
    repo: { owner: 'a', repo: 'b', commitSha: 'a'.repeat(40) },
  };
  try {
    for (const available of [false, true]) {
      globalThis.fetch = async (url) =>
        !available
          ? new Response('', { status: 400 })
          : Response.json(
              String(url).includes('www.cisa.gov')
                ? { vulnerabilities: [] }
                : { data: [{ cve: 'CVE-2020-1111', epss: '0', percentile: '0' }] },
            );
      const { findings } = await enrich([f({ aliases: ['CVE-2020-1111'] })], context);
      assert.equal(findings[0].exploit?.kev, available ? false : undefined);
      assert.equal(findings[0].exploit?.epss, available ? 0 : undefined);
      const issues = await buildIssues(findings, 'library', ctx);
      const report = verdict(findings, issues);
      if (available) {
        assert.match(issues[0].whyItMatters, /exploit probability 0%/);
        assert.match(report.headline, /0 listed in CISA KEV/);
      } else {
        assert.match(issues[0].whyItMatters, /Exploit probability unavailable/);
        for (const text of [issues[0].whyItMatters, report.headline, report.summary]) {
          assert.match(text, /Known exploitation status unavailable/);
          assert.doesNotMatch(text, /0%|0 listed|None is known/);
        }
      }
    }
    const mixed = [
      f({ exploit: undefined }),
      f({ id: 'confirmed', exploit: { kev: true, epss: 0.4 } }),
    ];
    const issues = await buildIssues(mixed, 'library', ctx);
    assert.match(issues[0].whyItMatters, /At least 1 listed in CISA KEV \(incomplete coverage\)/);
    assert.match(issues[0].whyItMatters, /Highest available exploit probability 40%/);
    assert.match(verdict(mixed, issues).headline, /incomplete coverage/);
  } finally {
    globalThis.fetch = original;
  }
});

test('scoring, deterministic order, verdict; KEV raises and dev lowers', async () => {
  const base = f(),
    kev = f({
      id: 'two',
      package: 'second',
      direct: true,
      introducedBy: ['second'],
      path: ['second@1.0.0'],
      exploit: { kev: true },
    });
  assert.ok(score(kev, 'web_service') > score(base, 'web_service'));
  assert.ok(score(f({ dev: true }), 'web_service') < score(base, 'web_service'));
  const issues = await buildIssues([base, kev], 'web_service', ctx);
  assert.deepEqual(issues, await buildIssues([base, kev], 'web_service', ctx));
  assert.equal(issues[0].directDependency, 'second');
  assert.equal(verdict([base, kev], issues).riskLevel, 'critical');
  assert.equal(verdict([], []).riskLevel, 'clean');
  const report = buildReport({
    findings: [base],
    issues,
    repoType: 'web_service',
    coverage: { scanned: ['package-lock.json'], notScanned: [] },
    stats: { packages: 1, lockfiles: 1 },
    repo: { owner: 'a', repo: 'b', ref: 'main', commitSha: 'a'.repeat(40) },
    advisoryDataAt: '2020-01-01',
    warnings: [],
    ai: { used: false },
    classifier: { source: 'rules' },
  });
  assert.match(issues[1].problem, /parent@1\.0\.0/);
  assert.match(issues[1].whyItMatters, /known vulnerabilities/);
  assert.equal(report.topIssues[0].id, issues[0].id);
  assert.equal(report.actionPlan.length, 2);
});
