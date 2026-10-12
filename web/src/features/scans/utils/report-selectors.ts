import type { Finding, Issue, Report } from '../types/scan-contracts.ts';

type Action = Report['actionPlan'][number];
export type FixGroup = { key: string; action?: Action; issues: Issue[] };

/**
 * Join each action-plan entry with its full issues (tolerating legacy singular/plural
 * id shapes); issues no action represents are grouped by identical fix shape instead.
 */
export function fixGroups(report: Report, issues: Issue[]): FixGroup[] {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const represented = new Set<string>();
  const groups = report.actionPlan.map((action, index) => {
    const members = (
      action.issueIds ??
      (action.issueId ? [action.issueId] : (action.locations?.map((l) => l.issueId) ?? []))
    )
      .map((id) => byId.get(id))
      .filter((issue): issue is Issue => !!issue);
    for (const issue of members) represented.add(issue.id);
    return { key: `action-${index}`, action, issues: members };
  });
  const noFix = new Map<string, FixGroup>();
  for (const issue of issues) {
    if (represented.has(issue.id)) continue;
    const key = JSON.stringify([
      issue.fix.kind,
      issue.fix.baseCommand ?? issue.fix.text ?? issue.fixText,
      ...(issue.fix.kind === 'override' ? [issue.fix.command] : []),
    ]);
    const group = noFix.get(key) ?? { key, issues: [] };
    group.issues.push(issue);
    noFix.set(key, group);
  }
  return [...groups, ...noFix.values()];
}

/** Shell commands for an action's locations; overrides yield none (JSON snippet, not shell). */
export function shellCommands(action: Action, issues: Issue[] = []): string[] {
  const kind = action.kind ?? issues[0]?.fix.kind;
  if (!kind || kind === 'override') return [];
  const locations = action.locations;
  return locations
    ? locations.flatMap((location) => (location.command ? [location.command] : []))
    : action.command
      ? [action.command]
      : [];
}

/** Findings across issues, deduplicated by id (one advisory can appear in several). */
export function associatedFindings(issues: Issue[]): Finding[] {
  return [
    ...new Map(issues.flatMap((issue) => issue.findings ?? []).map((f) => [f.id, f])).values(),
  ];
}
