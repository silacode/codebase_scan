import { ChevronDown, ExternalLink } from 'lucide-react';
import type { Issue, Report } from '../../types/scan-contracts';
import {
  Accordion,
  Badge,
  Button,
  CommandBlock,
  CopyButton,
  Panel,
} from '../../../../components/ui';
import { associatedFindings, fixGroups, shellCommands } from '../../utils/report-selectors';
import { count, folder } from '../../utils/report-formatters';
const levels = ['critical', 'high', 'medium', 'low'] as const;

function EvidenceSummary({
  issues,
  showEvidence,
}: {
  issues: Issue[];
  showEvidence: (issues: Issue[]) => void;
}) {
  const findings = associatedFindings(issues);
  return (
    findings.length > 0 && (
      <Button onClick={() => showEvidence(issues)} variant="quiet" className="px-0">
        View {count(findings.length, 'associated finding')}{' '}
        <ExternalLink aria-hidden="true" className="size-4" />
      </Button>
    )
  );
}

function LocationFix({
  loc,
  dir,
  override,
  fallbackApplyTo,
}: {
  loc: { command?: string; applyTo?: string };
  dir: string;
  override: boolean;
  fallbackApplyTo?: string;
}) {
  if (loc.command && (override || loc.applyTo))
    return (
      <CommandBlock
        value={loc.command}
        label={`Copy override snippet for ${dir}`}
        file={loc.applyTo ?? fallbackApplyTo ?? 'package.json'}
      />
    );
  if (loc.command)
    return (
      <>
        <CommandBlock value={loc.command} label={`Copy command for ${dir}`} />
        <p className="text-text-muted text-xs">Run from the repository root.</p>
      </>
    );
  if (loc.applyTo)
    return (
      <p className="text-text-secondary text-sm">
        Edit <code>{loc.applyTo}</code> manually.
      </p>
    );
  return (
    <p className="text-text-secondary text-sm">
      No command available. Follow the fix guidance above manually.
    </p>
  );
}

export function FixPlanSection({
  report,
  issues,
  showEvidence,
}: {
  report: Report;
  issues: Issue[];
  showEvidence: (issues: Issue[]) => void;
}) {
  const groups = fixGroups(report, issues);
  const all = groups.flatMap((group) =>
    group.action ? shellCommands(group.action, group.issues) : [],
  );
  return (
    <section className="grid gap-10 py-10 lg:grid-cols-[minmax(0,760px)_minmax(0,376px)] lg:gap-12">
      <div className="min-w-0">
        <div className="mb-6 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <h2 className="text-[28px] leading-[34px] font-bold tracking-[-.02em]">
              Do these in order
            </h2>
            <p className="text-text-secondary mt-2 text-sm">
              Ranked by severity, known exploitation and production exposure. Fixes come from the
              scan, not AI.
            </p>
          </div>
          {all.length > 0 && (
            <CopyButton
              value={all.join('\n')}
              label="Copy all shell commands"
              text="Copy all commands"
            />
          )}
        </div>
        {groups.length === 0 ? (
          <Panel>
            <h3 className="text-xl font-semibold">
              {report.coverage.scanned?.length
                ? 'No known vulnerabilities found in scanned lockfiles'
                : 'No supported npm lockfile was scanned'}
            </h3>
            <p className="text-text-secondary mt-2">
              Check Coverage for files and sources we could not scan.
            </p>
          </Panel>
        ) : (
          <Accordion.Root
            key={issues[0]?.id ?? 'empty'}
            defaultValue={[groups[0].key]}
            className="border-border bg-surface overflow-hidden rounded-lg border shadow-[0_12px_28px_#14243b0d]"
          >
            {groups.map((group, n) => {
              const representative = group.issues[0];
              const action = group.action;
              const findings = associatedFindings(group.issues);
              const commands = action ? shellCommands(action, group.issues) : [];
              const locations =
                action?.locations ??
                group.issues.map((issue) => ({
                  issueId: issue.id,
                  dir: issue.project?.dir ?? '.',
                  lockfile: issue.project?.lockfile ?? issue.lockfile ?? '',
                  command:
                    issue.fix.kind === 'no_fix'
                      ? undefined
                      : (action?.command ?? issue.fix.command),
                  applyTo: issue.fix.applyTo,
                  note: issue.fix.note,
                  from: issue.fix.from,
                  resolves: issue.fix.fixableCount ?? 0,
                }));
              const highest = levels.find((level) =>
                findings.some((finding) => finding.severity === level),
              );
              const epss = findings
                .map((finding) => finding.exploit?.epss)
                .filter((value): value is number => value != null);
              const maxEpss = epss.length ? Math.max(...epss) : null;
              const override = (action?.kind ?? representative?.fix.kind) === 'override';
              return (
                <Accordion.Item
                  key={group.key}
                  value={group.key}
                  className="group border-border min-w-0 border-b last:border-b-0"
                >
                  <Accordion.Header className="flex min-w-0 items-center">
                    <Accordion.Trigger className="flex min-h-18 min-w-0 flex-1 items-center gap-3 p-5 text-left">
                      <span className="text-primary shrink-0 font-mono text-sm font-semibold">
                        {String(n + 1).padStart(2, '0')}
                      </span>
                      <span className="min-w-0 flex-1">
                        <strong className="block text-base break-words">
                          {action?.action ??
                            representative?.fix.text ??
                            representative?.fixText ??
                            'No fix available'}
                        </strong>
                        <span className="text-text-secondary mt-1 block text-sm">
                          {action
                            ? `${count(action.resolves, 'fixable finding')} · ${action.effort} effort`
                            : `${count(findings.length, 'finding')} · no known fix`}
                          {locations.length > 1 && ` · ${count(locations.length, 'project')}`}
                        </span>
                      </span>
                      <ChevronDown
                        data-chevron
                        aria-hidden="true"
                        className="text-text-muted size-5 shrink-0"
                      />
                    </Accordion.Trigger>
                    {commands.length > 0 && (
                      <CopyButton
                        value={commands.join('\n')}
                        label={`Copy ${commands.length > 1 ? `${commands.length} commands` : 'command'} for fix ${n + 1}`}
                        text={
                          commands.length > 1 ? `Copy ${commands.length} commands` : 'Copy command'
                        }
                        compactOnMobile
                        className="mr-3 group-data-[open]:hidden"
                      />
                    )}
                  </Accordion.Header>
                  <Accordion.Panel className="border-border min-w-0 border-t px-5 pt-4 pb-5">
                    <div className="flex flex-wrap gap-2">
                      {findings.some((f) => f.exploit?.kev) && (
                        <Badge level="critical">CISA known exploited</Badge>
                      )}
                      {highest && <Badge level={highest}>{highest}</Badge>}
                      {maxEpss !== null && (
                        <Badge level="low">EPSS {Math.round(maxEpss * 100)}%</Badge>
                      )}
                      {representative?.fix.from && (
                        <Badge level="low">From {representative.fix.from}</Badge>
                      )}
                    </div>
                    <div className="mt-5 space-y-4">
                      {locations.map((loc, i) => (
                        <div
                          key={`${loc.issueId}-${i}`}
                          className="border-border min-w-0 space-y-2 border-t pt-4"
                        >
                          <p className="text-sm font-semibold break-all">
                            {folder(loc.dir)}{' '}
                            <span className="text-text-secondary font-normal">
                              · {loc.lockfile || 'Lockfile not recorded'}
                            </span>
                            {loc.from && (
                              <span className="text-text-secondary font-normal">
                                {' '}
                                · From {loc.from}
                              </span>
                            )}
                          </p>
                          {group.issues.find((issue) => issue.id === loc.issueId)?.project
                            ?.workspaces?.length ? (
                            <p className="text-text-secondary text-sm">
                              Workspaces:{' '}
                              {group.issues
                                .find((issue) => issue.id === loc.issueId)
                                ?.project?.workspaces.join(', ')}
                            </p>
                          ) : null}
                          {loc.note && <p className="text-text-secondary text-sm">{loc.note}</p>}
                          <LocationFix
                            loc={loc}
                            dir={folder(loc.dir)}
                            override={override}
                            fallbackApplyTo={representative?.fix.applyTo}
                          />
                        </div>
                      ))}
                      {!locations.length && (
                        <p className="text-text-secondary text-sm">
                          No command available. Follow the fix guidance above manually.
                        </p>
                      )}
                      {commands.length > 1 && (
                        <CopyButton
                          value={commands.join('\n')}
                          label={`Copy all commands for fix ${n + 1}`}
                          text="Copy project commands"
                        />
                      )}
                    </div>
                    {representative && (
                      <div className="border-border mt-5 grid gap-5 border-t pt-5 text-sm leading-6 sm:grid-cols-2">
                        <div>
                          <h4 className="font-semibold">Problem</h4>
                          <p className="text-text-secondary">{representative.problem}</p>
                        </div>
                        <div>
                          <h4 className="font-semibold">Root cause</h4>
                          <p className="text-text-secondary">{representative.rootCause}</p>
                        </div>
                        <div>
                          <h4 className="font-semibold">Fix</h4>
                          <p className="text-text-secondary">{representative.fixText}</p>
                        </div>
                        <div className="bg-primary-tint rounded-md p-4 sm:col-span-2">
                          <h4 className="font-semibold">
                            Why it matters{' '}
                            {representative.whySource === 'ai' && (
                              <span className="text-text-secondary font-normal">
                                · AI-written explanation
                              </span>
                            )}
                          </h4>
                          <p className="text-text-secondary">{representative.whyItMatters}</p>
                        </div>
                        <EvidenceSummary issues={group.issues} showEvidence={showEvidence} />
                      </div>
                    )}
                  </Accordion.Panel>
                </Accordion.Item>
              );
            })}
          </Accordion.Root>
        )}
      </div>
      <Panel as="aside" className="h-fit">
        <h2 className="text-lg font-semibold">How to read this</h2>
        <dl className="mt-5 space-y-4 text-sm">
          <div>
            <dt className="font-semibold">Ranking</dt>
            <dd className="text-text-secondary mt-1">
              Severity, known exploitation, exposure and repository context determine priority. AI
              cannot change this order.
            </dd>
          </div>
          <div>
            <dt className="font-semibold">Commands</dt>
            <dd className="text-text-secondary mt-1">
              Backend-authored commands are for the repository root. Review each change before
              running it. Override JSON belongs in the named package.json, not your shell.
            </dd>
          </div>
          <div>
            <dt className="font-semibold">Evidence</dt>
            <dd className="text-text-secondary mt-1">
              Open a fix's associated findings to inspect advisories, paths and exploit data. KEV
              means CISA lists known exploitation; EPSS is a probability estimate.
            </dd>
          </div>
        </dl>
      </Panel>
    </section>
  );
}
