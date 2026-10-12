import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Finding, ScanContext } from '../scanners/scanner-types.ts';
import type { Issue } from './issue-types.ts';
import {
  score,
  weights,
  effortRank,
  ISSUE_BONUS_MAX_SHARE,
  ISSUE_BONUS_OTHER_SCORES_SHARE,
} from './issue-scoring.ts';
import { fixIssue } from './remediation-planner.ts';

/** Keep issue descriptions readable while still counting omitted packages. */
const MAX_PACKAGE_SUMMARY_NAMES = 5;
/** Keep stable issue identifiers compact in reports and links. */
const ISSUE_ID_HASH_LENGTH = 10;
function listPackages(names: string[]) {
  const unique = [...new Set(names)];
  return `${unique.slice(0, MAX_PACKAGE_SUMMARY_NAMES).join(', ')}${unique.length > MAX_PACKAGE_SUMMARY_NAMES ? ` and ${unique.length - MAX_PACKAGE_SUMMARY_NAMES} more` : ''}`;
}
/**
 * Turn findings into prioritized Issues: group by lockfile × root dependency, choose a
 * fix per group, and sort by priority (fixability and effort break ties).
 */
export async function buildIssues(
  findings: Finding[],
  repoType: string,
  ctx: Pick<ScanContext, 'cache' | 'signal'>,
): Promise<Issue[]> {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const root = f.direct ? f.package : (f.introducedBy[0] ?? f.package);
    const key = `${f.lockfile}|${root}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const issues: Issue[] = [];
  for (const [key, group] of groups) {
    const direct = key.slice(key.indexOf('|') + 1),
      scores = group.map((f) => score(f, repoType)).sort((a, b) => b - a);
    // Top finding's score plus a merge bonus for the rest, capped at half the top score.
    const priority =
      scores[0] +
      Math.min(
        ISSUE_BONUS_MAX_SHARE * scores[0],
        ISSUE_BONUS_OTHER_SCORES_SHARE * scores.slice(1).reduce((a, b) => a + b, 0),
      );
    const project: Issue['project'] = {
      lockfile: group[0].lockfile,
      dir: path.posix.dirname(group[0].lockfile),
      // Root-scope fix unless a workspace actually introduced the group; then -w flags.
      workspaces: group.some((f) => f.introducedBy[0] === direct && !f.introducerWorkspaces?.length)
        ? []
        : [...new Set(group.flatMap((f) => f.introducerWorkspaces ?? []))].sort(),
    };
    const fix = await fixIssue(group, direct, ctx, project);
    fix.baseCommand ??= fix.text;
    const max = group.map((f) => f.severity).sort((a, b) => weights[b] - weights[a])[0];
    const exploited = group.filter((f) => f.exploit?.kev).length;
    const kevUnknown = group.some((f) => f.exploit?.kev == null);
    const epss = group
      .map((f) => f.exploit?.epss)
      .filter((value): value is number => value != null);
    const epssText = epss.length
      ? `Highest available exploit probability ${Math.round(Math.max(...epss) * 100)}%`
      : 'Exploit probability unavailable';
    const id =
      'ISS-' + createHash('sha256').update(key).digest('hex').slice(0, ISSUE_ID_HASH_LENGTH);
    const dependencyScope = (group[0].introducerDev ?? group[0].dev) ? 'development' : 'production';
    const exploitText = kevUnknown
      ? exploited
        ? `At least ${exploited} listed in CISA KEV (incomplete coverage)`
        : 'Known exploitation status unavailable'
      : `${exploited} listed in CISA KEV`;
    issues.push({
      id,
      title: `${direct}: ${group.length} vulnerable package${group.length === 1 ? '' : 's'}`,
      directDependency: direct,
      lockfile: group[0].lockfile,
      project,
      findings: group,
      findingIds: group.map((f) => f.id),
      otherIntroducers: [
        ...new Set(group.flatMap((f) => f.introducedBy).filter((n) => n !== direct)),
      ],
      priority,
      fix,
      problem: `${group.length} known vulnerabilities affect ${listPackages(group.map((f) => `${f.package}@${f.version}`))}.`,
      rootCause: `${direct} brings in ${listPackages(group.map((f) => f.package))} via ${group[0].path.join(' → ')}.`,
      fixText: fix.text + (fix.note ? ` ${fix.note[0].toUpperCase() + fix.note.slice(1)}.` : ''),
      whyItMatters:
        `${group.length} known vulnerabilities, highest severity ${max}. ` +
        `${exploitText}. ${epssText}. ` +
        `${direct} is a ${dependencyScope} dependency of a ${repoType.replace('_', ' ')}. ` +
        `Impact: ${group[0].context?.impactClass ?? 'other'}.`,
      whySource: 'template',
    });
  }
  return issues.sort(
    (a, b) =>
      b.priority - a.priority ||
      Number(b.fix.kind !== 'no_fix') - Number(a.fix.kind !== 'no_fix') ||
      effortRank[a.fix.effort] - effortRank[b.fix.effort] ||
      a.id.localeCompare(b.id),
  );
}
