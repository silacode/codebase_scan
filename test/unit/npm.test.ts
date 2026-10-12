import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadNodes,
  fixedVersion,
  mergeAliases,
  npmDependencies,
} from '../../src/scanners/npm-dependency-scanner.ts';
import { buildIssues } from '../../src/reports/issue-builder.ts';
import type { Finding, ScanContext } from '../../src/scanners/scanner-types.ts';
const fixture = async (name: string) =>
  JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
/** Write a lockfile (+ optional manifest) to a temp dir and load its graph. */
const loadInline = async (lock: unknown, manifest?: unknown) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'npm-graph-'));
  try {
    await writeFile(path.join(folder, 'package-lock.json'), JSON.stringify(lock));
    if (manifest !== undefined)
      await writeFile(path.join(folder, 'package.json'), JSON.stringify(manifest));
    return await loadNodes(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
};
const loadFixture = (name: string, manifest?: unknown) =>
  fixture(name).then((lock) => loadInline(lock, manifest));
test('v3: workspace direct, dev, nested override, link skipped and shortest path', async () => {
  const nodes = await loadFixture('v3-package-lock.json');
  assert.equal(nodes.length, 4);
  assert.equal(nodes.find((n) => n.name === 'tool')?.dev, true);
  assert.equal(nodes.find((n) => n.name === 'shared' && n.version === '3.0.0')?.direct, true);
  const nested = nodes.find((n) => n.name === 'shared' && n.version === '2.1.0')!;
  assert.equal(nested.direct, false);
  assert.deepEqual(nested.introducedBy, ['parent']);
  assert.deepEqual(nested.path, ['parent@1.0.0', 'shared@2.1.0']);
  assert.equal(nested.parent?.range, '^2.0.0');
  assert.ok(!nodes.some((n) => n.name === 'workspace-ui'));
});
test('workspace declarations generate -w only when the root does not declare the dependency', async () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { rootdep: '^1.0.0' } },
      'packages/app': { dependencies: { child: '^1.0.0' } },
      'node_modules/rootdep': { version: '1.0.0' },
      'node_modules/child': { version: '1.0.0' },
    },
  };
  const nodes = await loadInline(lock);
  assert.deepEqual(nodes.find((n) => n.name === 'child')?.introducerWorkspaces, ['packages/app']);
  assert.equal(nodes.find((n) => n.name === 'rootdep')?.introducerWorkspaces, undefined);
  const findings = nodes.map((node) => ({
    id: node.name,
    category: 'dependency' as const,
    advisoryId: 'GHSA-a',
    aliases: [],
    title: node.name,
    severity: 'high' as const,
    package: node.name,
    version: node.version,
    lockfile: 'package-lock.json',
    direct: node.direct,
    dev: node.dev,
    introducedBy: node.introducedBy,
    introducerWorkspaces: node.introducerWorkspaces,
    path: node.path,
    fixedVersion: '1.2.0',
    cweIds: [],
    references: [],
  }));
  const issues = await buildIssues(findings, 'library', {
    signal: new AbortController().signal,
    cache: { get: async <T>(_key: string) => undefined as T | undefined, set: async () => {} },
  });
  assert.equal(
    issues.find((i) => i.directDependency === 'child')?.fix.command,
    'npm install child@1.2.0 -w packages/app',
  );
  assert.equal(
    issues.find((i) => i.directDependency === 'rootdep')?.fix.command,
    'npm install rootdep@1.2.0',
  );
  const withRoot = structuredClone(lock) as {
    lockfileVersion: number;
    packages: Record<string, { dependencies?: Record<string, string>; version?: string }>;
  };
  withRoot.packages[''].dependencies!.child = '^1.0.0';
  assert.equal(
    (await loadInline(withRoot)).find((n) => n.name === 'child')?.introducerWorkspaces,
    undefined,
  );
});
test('v1: requires use nested walk-up and manifest for direct dependencies', async () => {
  const nodes = await loadFixture('v1-package-lock.json', {
    dependencies: { parent: '^1.0.0' },
    devDependencies: { tool: '^1.0.0' },
  });
  const nested = nodes.find((n) => n.name === 'shared')!;
  assert.deepEqual(nested.path, ['parent@1.0.0', 'shared@1.1.0']);
  assert.equal(nested.direct, false);
  assert.deepEqual(nested.introducedBy, ['parent']);
  assert.equal(nodes.find((n) => n.name === 'tool')?.dev, true);
});
test('introducedBy lists shortest direct-dependency path before longer ones', async () => {
  const nodes = await loadInline({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { a: '1', z: '1' } },
      'node_modules/a': { version: '1.0.0', dependencies: { middle: '1' } },
      'node_modules/a/node_modules/middle': { version: '1.0.0', dependencies: { shared: '1' } },
      'node_modules/z': { version: '1.0.0', dependencies: { shared: '1' } },
      'node_modules/shared': { version: '1.0.0' },
    },
  });
  const shared = nodes.find((n) => n.name === 'shared')!;
  assert.deepEqual(shared.introducedBy, ['z', 'a']);
  assert.deepEqual(shared.path, ['z@1.0.0', 'shared@1.0.0']);
});
test('production introducer beats a closer dev root and supplies the chosen path', async () => {
  const nodes = await loadInline({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { b: '1' }, devDependencies: { a: '1' } },
      'node_modules/a': { version: '1.0.0', dev: true, dependencies: { x: '1' } },
      'node_modules/b': { version: '1.0.0', dependencies: { middle: '1' } },
      'node_modules/middle': { version: '1.0.0', dependencies: { x: '1' } },
      'node_modules/x': { version: '1.0.0' },
    },
  });
  const x = nodes.find((n) => n.name === 'x')!;
  assert.deepEqual(x.introducedBy, ['b', 'a']);
  assert.deepEqual(x.path, ['b@1.0.0', 'middle@1.0.0', 'x@1.0.0']);
  assert.equal(x.parent?.name, 'middle');
  assert.equal(x.introducerDev, false);
  const finding = {
    id: 'x',
    category: 'dependency',
    advisoryId: 'MAL-x',
    aliases: [],
    title: 'x',
    severity: 'high',
    package: x.name,
    version: x.version,
    lockfile: 'package-lock.json',
    direct: x.direct,
    dev: x.dev,
    introducedBy: x.introducedBy,
    introducerDev: x.introducerDev,
    path: x.path,
    parent: x.parent,
    cweIds: [],
    references: [],
  } satisfies Finding;
  const [issue] = await buildIssues([finding], 'library', {
    signal: new AbortController().signal,
    cache: { get: async <T>(_key: string) => undefined as T | undefined, set: async () => {} },
  });
  assert.equal(issue.directDependency, 'b');
  assert.match(issue.whyItMatters, /production dependency/);
});
test('OSV pagination sends only pending queries and MAL advisories are critical', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'npm-pagination-'));
  await writeFile(
    path.join(folder, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { a: '1', b: '1' } },
        'node_modules/a': { version: '1.0.0' },
        'node_modules/b': { version: '1.0.0' },
      },
    }),
  );
  const original = globalThis.fetch;
  const calls: unknown[][] = [];
  globalThis.fetch = async (_url, init) => {
    if (String(_url).includes('querybatch')) {
      const queries = (JSON.parse(String(init?.body)) as { queries: unknown[] }).queries;
      calls.push(queries);
      return Response.json({
        results:
          calls.length === 1
            ? [{ vulns: [], next_page_token: 'next' }, { vulns: [] }]
            : [{ vulns: [{ id: 'MAL-123' }] }],
      });
    }
    return Response.json({ id: 'MAL-123', summary: 'bad code', affected: [] });
  };
  const ctx = {
    workspaceDir: folder,
    repo: { owner: 'a', repo: 'b', commitSha: 'a'.repeat(40) },
    signal: new AbortController().signal,
    progress: async () => {},
    cache: { get: async <T>(_key: string) => undefined as T | undefined, set: async () => {} },
  } satisfies ScanContext;
  try {
    const result = await npmDependencies.run(ctx);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].length, 1);
    assert.deepEqual(calls[1][0], {
      package: { name: 'a', ecosystem: 'npm' },
      version: '1.0.0',
      page_token: 'next',
    });
    assert.equal(result.findings[0].severity, 'critical');
    assert.equal(result.findings[0].title, 'Malicious package: bad code');
  } finally {
    globalThis.fetch = original;
    await rm(folder, { recursive: true, force: true });
  }
});
test('fixedVersion uses the matching affected range, not a different range; missing fix stays missing', () => {
  const vuln = {
    id: 'V1',
    affected: [
      {
        package: { name: 'pkg', ecosystem: 'npm' },
        ranges: [
          {
            type: 'SEMVER',
            events: [
              { introduced: '0' },
              { fixed: '1.2.0' },
              { introduced: '2.0.0' },
              { fixed: '2.2.0' },
            ],
          },
        ],
      },
    ],
  };
  assert.equal(fixedVersion(vuln, 'pkg', '1.0.0'), '1.2.0');
  assert.equal(fixedVersion(vuln, 'pkg', '2.1.0'), '2.2.0');
  assert.equal(fixedVersion(vuln, 'pkg', '3.0.0'), undefined);
  assert.equal(
    fixedVersion(
      {
        id: 'NO',
        affected: [
          {
            package: { name: 'pkg', ecosystem: 'npm' },
            ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }],
          },
        ],
      },
      'pkg',
      '1.0.0',
    ),
    undefined,
  );
});
test('merge advisories sharing aliases per package version and lockfile', () => {
  const f = {
    id: 'first',
    category: 'dependency',
    advisoryId: 'GHSA-a',
    aliases: ['CVE-2020-1234'],
    title: 'x',
    severity: 'high',
    package: 'pkg',
    version: '1.0.0',
    lockfile: 'package-lock.json',
    direct: true,
    dev: false,
    introducedBy: ['pkg'],
    path: ['pkg@1.0.0'],
    cweIds: [],
    references: [],
  } as Finding;
  const merged = mergeAliases([
    f,
    { ...f, id: 'second', advisoryId: 'OSV-a', aliases: ['CVE-2020-1234'] },
    { ...f, id: 'third', package: 'other' },
  ]);
  assert.equal(merged.length, 2);
  assert.ok(merged[0].aliases.includes('OSV-a'));
  const bridged = mergeAliases([
    { ...f, id: 'a', aliases: ['CVE-2020-1'] },
    { ...f, id: 'b', advisoryId: 'GHSA-b', aliases: ['CVE-2020-2'] },
    { ...f, id: 'c', advisoryId: 'GHSA-c', aliases: ['CVE-2020-1', 'CVE-2020-2'] },
  ]);
  assert.equal(bridged.length, 1);
  assert.ok(bridged[0].aliases.includes('GHSA-b'));
});
