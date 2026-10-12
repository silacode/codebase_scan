import { SCANNER_VERSION } from '../config.ts';
import type { Finding } from '../scanners/scanner-types.ts';
import type { Issue } from './issue-types.ts';
import { effortRank } from './issue-scoring.ts';

/** Keep the prioritized action summary short without hiding the full issue list. */
const MAX_TOP_FIX_GROUPS = 5;
/** Group issues whose fix command is identical, so the action plan prints each step once. */
export function groupFixes(issues: Issue[]) {
  const groups = new Map<string, Issue[]>();
  for (const issue of issues) {
    const fix = issue.fix;
    const key = JSON.stringify([
      fix.kind,
      fix.baseCommand ?? fix.text,
      ...(fix.kind === 'override' ? [fix.command] : []),
    ]);
    groups.set(key, [...(groups.get(key) ?? []), issue]);
  }
  return [...groups.values()];
}
const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** Risk level from the top: any prod KEV/critical → critical, prod high → high, …, clean. */
export function verdict(findings: Finding[], issues: Issue[]) {
  const prod = findings.filter((f) => !f.dev);
  const riskLevel = prod.some((f) => f.exploit?.kev || f.severity === 'critical')
    ? 'critical'
    : prod.some((f) => f.severity === 'high')
      ? 'high'
      : prod.some((f) => f.severity === 'medium') ||
          findings.some((f) => f.dev && ['high', 'critical'].includes(f.severity))
        ? 'medium'
        : findings.length
          ? 'low'
          : 'clean';
  const exploited = findings.filter((f) => f.exploit?.kev).length;
  const exploitText = findings.some((f) => f.exploit?.kev == null)
    ? exploited
      ? `At least ${exploited} listed in CISA KEV (incomplete coverage)`
      : 'Known exploitation status unavailable'
    : `${exploited} listed in CISA KEV`;
  const groups = groupFixes(issues);
  const projects = new Set(issues.map((issue) => issue.lockfile)).size;
  const actionable = groups.filter((group) => group[0].fix.kind !== 'no_fix').length;
  const headline =
    `${riskLevel[0].toUpperCase() + riskLevel.slice(1)} risk: ` +
    `${groups.length} distinct fix${groups.length === 1 ? '' : 'es'} in ${counted(projects, 'project')}, ${exploitText}`;
  return {
    riskLevel,
    headline,
    summary: `${counted(findings.length, 'finding')} in ${counted(issues.length, 'issue')} across ${counted(projects, 'project')}; ${exploitText}. ${counted(actionable, 'actionable fix group')}.`,
  };
}
/** The five fix groups with the highest-priority members; extras are listed in `alsoIn`. */
export function topIssues(issues: Issue[]) {
  return groupFixes(issues)
    .slice(0, MAX_TOP_FIX_GROUPS)
    .map(([first, ...others]) => ({
      ...first,
      alsoIn: others.map((i) => ({ issueId: i.id, lockfile: i.lockfile, dir: i.project.dir })),
    }));
}
/** Assemble the final scan report document from issues, coverage and provenance. */
export function buildReport(args: {
  findings: Finding[];
  issues: Issue[];
  repoType: string;
  coverage: { scanned: string[]; notScanned: { what: string; why: string }[] };
  stats: Record<string, number>;
  repo: { owner: string; repo: string; ref: string; commitSha: string };
  advisoryDataAt: string;
  kevCatalogAt?: string;
  warnings: string[];
  ai: { used: boolean; model?: string; fallbackReason?: string };
  classifier: { source: 'rules' | 'jev' };
}) {
  const { findings, issues, repo } = args;
  return {
    verdict: verdict(findings, issues),
    topIssues: topIssues(issues),
    actionPlan: groupFixes(issues)
      .filter((group) => group[0].fix.kind !== 'no_fix')
      .map((group, n) => {
        const first = group[0];
        const locations = group.map((i) => ({
          issueId: i.id,
          lockfile: i.lockfile,
          dir: i.project.dir,
          from: i.fix.from,
          command: i.fix.command,
          applyTo: i.fix.applyTo,
          resolves: i.fix.fixableCount,
          note: i.fix.note,
        }));
        return {
          order: n + 1,
          kind: first.fix.kind,
          baseCommand: first.fix.baseCommand,
          action: first.fix.text + (group.length > 1 ? ` In ${group.length} projects.` : ''),
          effort: group.reduce(
            (highest, i) =>
              effortRank[i.fix.effort] > effortRank[highest] ? i.fix.effort : highest,
            first.fix.effort,
          ),
          resolves: locations.reduce((sum, location) => sum + location.resolves, 0),
          issueIds: group.map((i) => i.id),
          locations,
          ...(locations.length === 1 ? { command: first.fix.command } : {}),
        };
      }),
    issueCount: issues.length,
    stats: {
      ...args.stats,
      severity: Object.fromEntries(
        ['critical', 'high', 'medium', 'low'].map((s) => [
          s,
          findings.filter((f) => f.severity === s).length,
        ]),
      ),
      prod: findings.filter((f) => !f.dev).length,
      dev: findings.filter((f) => f.dev).length,
      direct: findings.filter((f) => f.direct).length,
      transitive: findings.filter((f) => !f.direct).length,
    },
    coverage: args.coverage,
    provenance: {
      ...repo,
      scannerVersion: SCANNER_VERSION,
      advisoryDataAt: args.advisoryDataAt,
      kevCatalogAt: args.kevCatalogAt,
      scannedAt: new Date().toISOString(),
    },
    ai: args.ai,
    classifier: args.classifier,
    warnings: args.warnings,
  };
}
