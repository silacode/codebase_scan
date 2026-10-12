import type { Page } from '@playwright/test';
import type {
  Finding,
  Issue,
  Report,
  Scan,
} from '../../web/src/features/scans/types/scan-contracts.ts';
export const findings: Finding[] = Array.from({ length: 8 }, (_, n) => ({
  id: `finding-${n}`,
  category: 'dependency',
  title: `Advisory title ${n}`,
  advisoryId: `GHSA-${n}`,
  aliases: [],
  references: [],
  package: `package-${n}`,
  version: '1.0.0',
  lockfile: n === 0 ? 'apps/a/package-lock.json' : 'package-lock.json',
  path: [`direct-${n}`, `package-${n}`],
  introducedBy: [],
  cweIds: [],
  severity: n === 0 ? 'critical' : 'high',
  dev: n % 2 === 1,
  direct: n % 2 === 0,
  fixedVersion: n === 7 ? undefined : '2.0.0',
  exploit: { kev: n === 0, epss: n === 0 ? 0.2 : 0.01 },
}));
export const issues: Issue[] = findings.map((f, n) => ({
  id: `issue-${n}`,
  title: `Fix package ${n}`,
  directDependency: f.package,
  lockfile: f.lockfile,
  otherIntroducers: [],
  priority: 1,
  problem: `Problem ${n}`,
  rootCause: `Root cause ${n}`,
  fixText: `Fix guidance ${n}`,
  whyItMatters: `Reason ${n}`,
  whySource: n === 0 ? 'ai' : 'template',
  findingIds: [f.id],
  findings: [f],
  project: {
    dir: n === 1 ? 'apps/b' : 'apps/a',
    lockfile: n === 1 ? 'apps/b/package-lock.json' : 'apps/a/package-lock.json',
    workspaces: [],
  },
  fix: {
    kind: n === 7 ? 'no_fix' : n === 6 ? 'override' : 'upgrade_direct',
    command:
      n === 6
        ? '{"overrides":{"package-6":"2.0.0"}}'
        : n === 7
          ? undefined
          : `npm --prefix apps/a install package-${n}@2.0.0`,
    effort: 'low',
    text: `Upgrade package ${n}`,
    applyTo: n === 6 ? 'apps/a/package.json' : undefined,
    fixableCount: 1,
    unfixableCount: 0,
  },
}));
export const report: Report = {
  verdict: {
    riskLevel: 'critical',
    headline: 'Critical risk: 8 distinct fixes in 2 projects, 1 known to be exploited',
    summary:
      '8 findings in 8 issues across 2 projects; 1 known exploited. 7 actionable fix groups.',
  },
  topIssues: issues.slice(0, 5),
  actionPlan: [
    {
      order: 1,
      issueIds: ['issue-0', 'issue-1'],
      kind: 'upgrade_direct',
      action: 'Upgrade package 0 in two projects',
      effort: 'low',
      resolves: 2,
      locations: [
        {
          issueId: 'issue-0',
          dir: 'apps/a',
          lockfile: 'apps/a/package-lock.json',
          resolves: 1,
          command: 'npm --prefix apps/a install package-0@2.0.0',
          note: 'Verify after upgrading',
        },
        {
          issueId: 'issue-1',
          dir: 'apps/b',
          lockfile: 'apps/b/package-lock.json',
          resolves: 1,
          command: "npm --prefix 'apps/b' install package-0@2.0.0",
        },
      ],
    },
    ...issues.slice(2, 7).map((issue, n) => ({
      order: n + 2,
      issueIds: [issue.id],
      kind: issue.fix.kind,
      action: `Upgrade package ${n + 2}`,
      effort: 'low' as const,
      resolves: 1,
      locations: [
        {
          issueId: issue.id,
          dir: 'apps/a',
          lockfile: 'apps/a/package-lock.json',
          resolves: 1,
          command: issue.fix.command,
          applyTo: issue.fix.applyTo,
        },
      ],
    })),
  ],
  issueCount: 8,
  stats: {
    packages: 18,
    lockfiles: 2,
    prod: 4,
    dev: 4,
    direct: 4,
    transitive: 4,
    severity: { critical: 1, high: 7, medium: 0, low: 0 },
  },
  coverage: {
    scanned: ['apps/a/package-lock.json'],
    notScanned: [{ what: 'pnpm-lock.yaml', why: 'Not supported' }],
  },
  provenance: {
    owner: 'example',
    repo: 'sample',
    ref: 'main',
    commitSha: 'a'.repeat(40),
    scannerVersion: '1.1.0',
    advisoryDataAt: '2026-01-01T00:00:00Z',
    kevCatalogAt: '2026-01-02T00:00:00Z',
    scannedAt: '2026-01-03T00:00:00Z',
  },
  ai: { used: true },
  classifier: { source: 'rules' },
  warnings: ['KEV unavailable'],
};
export const snapshot = (
  status: Scan['status'] = 'completed',
  change: Partial<Scan> = {},
): Scan => ({
  id: 'scan-a',
  owner: 'example',
  repo: 'sample',
  ref: 'main',
  commitSha: 'a'.repeat(40),
  status,
  stage: status === 'queued' ? 'queued' : 'publish',
  progress: status === 'completed' ? 100 : status === 'queued' ? 0 : 40,
  queuePosition: 0,
  createdAt: '2026-01-01T00:00:00Z',
  startedAt: status === 'queued' ? null : '2026-01-01T00:00:30Z',
  finishedAt: ['completed', 'failed', 'cancelled'].includes(status) ? '2026-01-01T00:01:00Z' : null,
  report: status === 'completed' ? report : null,
  error:
    status === 'failed'
      ? { code: 'RATE_LIMITED', message: 'Try again later', retryable: true }
      : null,
  events: [
    { seq: 1, at: '2026-01-01T00:00:00Z', stage: 'queued', level: 'info', message: 'Scan queued' },
  ],
  ...change,
});
export async function mockApi(
  page: Page,
  scan: Scan = snapshot(),
  allIssues: Issue[] = issues,
  allFindings: Finding[] = findings,
) {
  let live = scan;
  await page.route('**/api/scans/*', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(live) }),
  );
  await page.route('**/api/scans', (route) =>
    route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(scan) }),
  );
  await page.route('**/api/scans/*/issues', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: allIssues }) }),
  );
  await page.route('**/api/scans/*/findings?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    const filtered = allFindings.filter(
      (f) =>
        (!query.has('severity') || f.severity === query.get('severity')) &&
        (!query.has('dev') || String(f.dev) === query.get('dev')) &&
        (!query.has('direct') || String(f.direct) === query.get('direct')),
    );
    const offset = Number(query.get('offset') ?? 0),
      limit = Number(query.get('limit') ?? 10);
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        offset,
        limit,
      }),
    });
  });
  await page.route('**/api/scans/*/cancel', (route) => {
    live = { ...live, status: 'cancelled', error: null, report: null };
    return route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ id: scan.id, status: 'cancellation_requested' }),
    });
  });
  await page.route('**/api/scans/*/events', (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: 'event: end\ndata: {}\n\n' }),
  );
}
