import { useState } from 'react';
import { RotateCw } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { getScanIssues } from '../api/scan-api';
import type { Issue, Report, Scan } from '../types/scan-contracts';
import { Badge, Button, CopyButton, Notice, Tabs } from '../../../components/ui';
import { FixPlanSection } from '../components/report/FixPlanSection';
import { FindingsEvidenceSection } from '../components/report/FindingsEvidenceSection';
import { ScanCoverageSection } from '../components/report/ScanCoverageSection';
import { ScanRepositoryIdentity } from '../components/ScanRepositoryIdentity';
import { count, date, message } from '../utils/report-formatters';
import { fixGroups } from '../utils/report-selectors';
const levels = ['critical', 'high', 'medium', 'low'] as const;

function FixPanel({
  report,
  items,
  error,
  onRetry,
  showEvidence,
}: {
  report: Report;
  items: Issue[] | null;
  error: string;
  onRetry: () => void;
  showEvidence: (issues: Issue[]) => void;
}) {
  if (items && report.issueCount > 0 && items.length === 0)
    return (
      <Notice error>The complete issue list is unavailable; this is not a clean result.</Notice>
    );
  if (items) return <FixPlanSection report={report} issues={items} showEvidence={showEvidence} />;
  if (error)
    return (
      <div className="py-10">
        <Notice error>
          Unable to load the complete fix list: {error} <Button onClick={onRetry}>Retry</Button>
        </Notice>
      </div>
    );
  return (
    <p className="py-10" role="status">
      Loading all fixes…
    </p>
  );
}

export function ScanReportScreen({ scan, rescan }: { scan: Scan; rescan: () => void }) {
  const report = scan.report!;
  const [tab, setTab] = useState('fix');
  const [selected, setSelected] = useState<Issue[] | null>(null);
  const issuesQuery = useQuery({
    queryKey: ['scanIssues', scan.id],
    queryFn: ({ signal }) => getScanIssues(scan.id, signal),
  });
  const items = issuesQuery.data?.items ?? null;
  const error = issuesQuery.isError ? message(issuesQuery.error) : '';
  const stats = report.stats;
  const noLockfile = report.coverage.scanned?.length === 0;
  const distribution = levels.map((level) => stats.severity?.[level] ?? 0);
  const sum = levels.every((level) => Number.isFinite(stats.severity?.[level]))
    ? distribution.reduce((a, b) => a + b, 0)
    : null;
  const severityColors = ['bg-critical', 'bg-high', 'bg-medium', 'bg-low'];
  const riskIndex = levels.indexOf(report.verdict.riskLevel as (typeof levels)[number]);
  let riskLabel = `${report.verdict.riskLevel} risk`;
  if (noLockfile) riskLabel = 'Coverage unavailable';
  else if (report.verdict.riskLevel === 'clean') riskLabel = 'No known findings';
  return (
    <main className="max-w-content mx-auto px-5 pb-16 md:px-8 xl:px-0">
      <div className="flex flex-wrap items-start justify-between gap-4 pt-8 md:pt-10">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <ScanRepositoryIdentity scan={scan} />
          {scan.cached && <Badge level="low">Cached report</Badge>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={rescan}>
            <RotateCw aria-hidden="true" className="size-4" /> Rescan
          </Button>
          <CopyButton value={location.href} label="Copy report link" text="Copy link" />
        </div>
      </div>
      <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,760px)_minmax(0,376px)] lg:gap-16">
        <section className="min-w-0">
          <div className="flex items-center gap-3">
            <span className="flex gap-1" aria-hidden="true">
              {levels.map((level, n) => (
                <span
                  key={level}
                  className={`rounded-pill h-1.5 w-7 ${riskIndex >= 0 && n >= riskIndex ? severityColors[riskIndex] : 'bg-border'}`}
                />
              ))}
            </span>
            <Badge level={report.verdict.riskLevel}>{riskLabel}</Badge>
          </div>
          <h1 className="mt-5 max-w-[760px] text-[32px] leading-[36px] font-bold tracking-[-.035em] md:text-[44px] md:leading-[48px]">
            {noLockfile ? 'No supported npm lockfile was scanned' : report.verdict.headline}
          </h1>
          <p className="text-text-secondary mt-4 max-w-[690px] text-base leading-7">
            {report.verdict.summary}
          </p>
          <p className="text-text-muted mt-3 text-xs">
            Scan completed {date(report.provenance.scannedAt)} · Classification:{' '}
            {report.classifier?.source ?? 'not recorded'}
          </p>
        </section>
        <aside className="border-border min-w-0 border-t pt-5 lg:border-t-0 lg:pt-0">
          <h2 className="text-text-secondary text-xs font-semibold tracking-wide uppercase">
            Findings by severity
          </h2>
          {stats.severity ? (
            <>
              {sum !== null ? (
                <div
                  className="rounded-pill bg-low-tint mt-5 flex h-2 overflow-hidden"
                  aria-hidden="true"
                >
                  {levels.map((level, n) => (
                    <span
                      key={level}
                      style={{ width: `${sum ? (distribution[n] / sum) * 100 : 0}%` }}
                      className={severityColors[n] as string}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-text-secondary mt-5 text-sm">
                  Severity distribution incomplete.
                </p>
              )}
              <div className="mt-4 grid grid-cols-2 gap-3">
                {levels.map((level, n) => (
                  <div key={level} className="flex items-center gap-2 text-sm">
                    <span className={`size-2 rounded-full ${severityColors[n]}`} />
                    {level}: {stats.severity?.[level] ?? '—'}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-text-secondary mt-4 text-sm">
              Severity totals not recorded in this report.
            </p>
          )}
          <div className="border-border mt-5 grid grid-cols-2 gap-2 border-t pt-4 text-sm">
            {[
              ['Packages', stats.packages],
              ['Lockfiles', stats.lockfiles],
              ['Production', stats.prod],
              ['Development', stats.dev],
              ['Direct', stats.direct],
              ['Transitive', stats.transitive],
            ].map(([label, value]) => (
              <div key={label}>
                <span className="text-text-muted">{label}</span>
                <strong className="ml-2">
                  {typeof value === 'number' && Number.isFinite(value) ? value : '—'}
                </strong>
              </div>
            ))}
          </div>
        </aside>
      </div>
      {report.warnings?.length > 0 && (
        <div className="mt-6 space-y-2">
          {report.warnings.map((warning, i) => (
            <Notice key={i}>Partial coverage: {warning}</Notice>
          ))}
        </div>
      )}
      {report.coverage?.notScanned?.length > 0 && !report.warnings?.length && (
        <div className="mt-6">
          <Notice>Some sources were not scanned. Review the Coverage tab for details.</Notice>
        </div>
      )}
      <Tabs.Root
        value={tab}
        onValueChange={(value) => setTab(String(value))}
        className="mt-10 min-w-0"
      >
        <Tabs.List
          aria-label="Report sections"
          className="border-border flex max-w-full gap-3 border-b sm:gap-8"
        >
          {[
            [
              'fix',
              'Fix plan',
              String(items ? fixGroups(report, items).length : report.actionPlan.length),
            ],
            ['evidence', 'Evidence', sum === null ? '' : String(sum)],
            [
              'coverage',
              'Coverage',
              `${report.coverage.notScanned?.length ?? 0} gap${report.coverage.notScanned?.length === 1 ? '' : 's'}`,
            ],
          ].map(([value, label, total]) => (
            <Tabs.Tab
              key={value}
              value={value}
              className="min-h-12 shrink-0 border-b-2 px-1 text-sm font-semibold sm:px-2"
            >
              {label}
              {value === 'coverage' && report.coverage.notScanned?.length > 0 && (
                <span
                  aria-hidden="true"
                  className="bg-primary ml-1 inline-block size-1.5 rounded-full sm:hidden"
                />
              )}
              {total !== '' && (
                <span className="sm:rounded-pill sm:bg-low-tint sm:text-text-secondary sr-only sm:not-sr-only sm:ml-1 sm:px-2 sm:py-1 sm:text-xs">
                  {total}
                </span>
              )}
              {value === 'evidence' && selected && (
                <span className="sr-only sm:not-sr-only"> · filtered</span>
              )}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <Tabs.Panel value="fix">
          <FixPanel
            report={report}
            items={items}
            error={error}
            onRetry={() => void issuesQuery.refetch()}
            showEvidence={(group) => {
              setSelected(group);
              setTab('evidence');
            }}
          />
        </Tabs.Panel>
        <Tabs.Panel value="evidence">
          <FindingsEvidenceSection
            id={scan.id}
            selected={selected}
            clear={() => setSelected(null)}
            counts={stats.severity}
            severityTotal={sum}
          />
        </Tabs.Panel>
        <Tabs.Panel value="coverage">
          <ScanCoverageSection report={report} />
        </Tabs.Panel>
      </Tabs.Root>
      <footer className="border-border text-text-muted mt-4 flex flex-wrap gap-4 border-t pt-6 text-xs">
        <span>{count(report.issueCount, 'issue')} recorded</span>
        <span>Scanner {report.provenance.scannerVersion ?? 'not recorded'}</span>
        <span>Advisory data {date(report.provenance.advisoryDataAt)}</span>
      </footer>
    </main>
  );
}
