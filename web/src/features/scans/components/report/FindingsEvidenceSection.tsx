import { useEffect, useState, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { getScanFindings } from '../../api/scan-api';
import { Badge, Button, Notice, Select, Toggle, ToggleGroup } from '../../../../components/ui';
import { associatedFindings } from '../../utils/report-selectors';
import { message } from '../../utils/report-formatters';
import type { Finding, Issue } from '../../types/scan-contracts';
// Independent of the API page default.
const pageSize = 10;
const severities = ['critical', 'high', 'medium', 'low'] as const;
const options = (values: [string, string][]) => values.map(([value, label]) => ({ value, label }));

function EvidenceTable({ items }: { items: Finding[] }) {
  return (
    <div
      className="border-border bg-surface max-w-full overflow-x-auto rounded-lg border"
      tabIndex={0}
      role="region"
      aria-label="Scrollable findings table"
    >
      <table className="w-full min-w-[950px] text-left text-sm">
        <thead className="bg-low-tint text-text-secondary text-xs">
          <tr>
            {[
              'Severity',
              'Package',
              'Advisory',
              'Dependency path',
              'Scope',
              'Fixed',
              'Exploit data',
            ].map((h) => (
              <th key={h} scope="col" className="border-border border-b px-4 py-3 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((f) => (
            <tr key={f.id} className="border-border border-b align-top">
              <td className="px-4 py-4">
                <Badge level={f.severity} />
              </td>
              <td className="px-4 py-4 font-mono text-xs">
                {f.package}@{f.version}
              </td>
              <td className="max-w-[220px] px-4 py-4">
                <a
                  href={`https://osv.dev/vulnerability/${encodeURIComponent(f.advisoryId)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium"
                >
                  {f.title ?? f.advisoryId}{' '}
                  <ExternalLink aria-label="Opens in new tab" className="inline size-3" />
                </a>
                <p className="text-text-muted mt-1 font-mono text-xs">{f.advisoryId}</p>
              </td>
              <td className="max-w-[190px] px-4 py-4 font-mono text-xs break-all">
                {f.lockfile ?? 'Not recorded'}
                {f.path?.length ? <p className="mt-1">{f.path.join(' → ')}</p> : null}
              </td>
              <td className="px-4 py-4">
                {f.direct ? 'Direct' : 'Transitive'} · {f.dev ? 'Dev' : 'Prod'}
              </td>
              <td className="px-4 py-4 font-mono text-xs">{f.fixedVersion ?? 'Not known'}</td>
              <td className="px-4 py-4">
                {f.exploit?.kev ? 'CISA KEV · ' : ''}
                {f.exploit?.epss != null
                  ? `${Math.round(f.exploit.epss * 100)}% EPSS`
                  : 'Not recorded'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EvidencePages({
  offset,
  total,
  onPrev,
  onNext,
}: {
  offset: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <nav
      aria-label="Evidence pages"
      className="flex flex-wrap items-center justify-between gap-3 text-sm"
    >
      <span>
        Showing {offset + 1}–{Math.min(offset + pageSize, total)} of {total}
      </span>
      <div className="flex gap-2">
        <Button disabled={offset === 0} onClick={onPrev}>
          Previous
        </Button>
        <Button disabled={offset + pageSize >= total} onClick={onNext}>
          Next
        </Button>
      </div>
    </nav>
  );
}

export function FindingsEvidenceSection({
  id,
  selected,
  clear,
  counts,
  severityTotal,
}: {
  id: string;
  selected: Issue[] | null;
  clear: () => void;
  counts?: Partial<Record<(typeof severities)[number], number>>;
  severityTotal: number | null;
}) {
  const [severity, setSeverity] = useState('all');
  const [dev, setDev] = useState('all');
  const [direct, setDirect] = useState('all');
  const [offset, setOffset] = useState(0);
  const local = selected
    ? associatedFindings(selected).filter(
        (f) =>
          (severity === 'all' || f.severity === severity) &&
          (dev === 'all' || String(f.dev) === dev) &&
          (direct === 'all' || String(f.direct) === direct),
      )
    : [];
  useEffect(() => {
    setOffset(0);
  }, [id, selected, severity, dev, direct]);
  const findingsQuery = useQuery({
    queryKey: ['scanFindings', id, severity, dev, direct, offset],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ offset: String(offset), limit: String(pageSize) });
      if (severity !== 'all') params.set('severity', severity);
      if (dev !== 'all') params.set('dev', dev);
      if (direct !== 'all') params.set('direct', direct);
      return getScanFindings(id, params, signal);
    },
    enabled: !selected,
  });
  const data = findingsQuery.data ?? null;
  const error = findingsQuery.isError ? message(findingsQuery.error) : '';
  const total = selected ? local.length : (data?.total ?? 0);
  const items = selected ? local.slice(offset, offset + pageSize) : (data?.items ?? []);
  let body: ReactNode;
  if (error)
    body = (
      <Notice error>
        Unable to load evidence: {error}{' '}
        <Button onClick={() => void findingsQuery.refetch()} className="ml-3">
          Retry
        </Button>
      </Notice>
    );
  else if (!selected && !data) body = <p role="status">Loading evidence…</p>;
  else if (total === 0) body = <Notice>No findings match these filters.</Notice>;
  else
    body = (
      <>
        <EvidenceTable items={items} />
        <EvidencePages
          offset={offset}
          total={total}
          onPrev={() => setOffset((n) => Math.max(0, n - pageSize))}
          onNext={() => setOffset((n) => n + pageSize)}
        />
      </>
    );
  return (
    <section className="min-w-0 space-y-6 py-10">
      <div>
        <h2 className="text-[28px] font-bold tracking-[-.02em]">
          {selected
            ? `Evidence for ${selected.length === 1 ? selected[0].title : `${selected.length} projects`}`
            : `All findings${data ? ` · ${total}` : ''}`}
        </h2>
        <p className="text-text-secondary mt-2 text-sm">
          Every advisory matched against the scanned lockfiles. The fix plan groups them into
          actions.
        </p>
        {selected && (
          <Button variant="quiet" onClick={clear} className="mt-2 px-0">
            Clear issue filter · See all findings
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          value={[severity]}
          onValueChange={(next) => setSeverity(next[0] ?? severity)}
          aria-label="Severity"
          className="border-border bg-surface flex max-w-full flex-wrap items-center gap-1 rounded-lg border p-1"
        >
          {['all', ...severities].map((level) => (
            <Toggle
              key={level}
              value={level}
              render={
                <Button
                  variant={severity === level ? 'primary' : 'quiet'}
                  className="min-h-10 rounded-md px-3 capitalize"
                />
              }
            >
              {level === 'all' ? 'All' : level}
              {(level === 'all'
                ? severityTotal !== null
                : Number.isFinite(counts?.[level as (typeof severities)[number]])) && (
                <span className="text-xs opacity-80">
                  {level === 'all' ? severityTotal : counts?.[level as (typeof severities)[number]]}
                </span>
              )}
            </Toggle>
          ))}
        </ToggleGroup>
        <div className="flex min-w-0 flex-wrap gap-3">
          <Select
            className="w-[calc(50%-6px)] sm:w-40"
            label="Scope"
            value={dev}
            onChange={setDev}
            choices={options([
              ['all', 'All scopes'],
              ['false', 'Production'],
              ['true', 'Development'],
            ])}
          />
          <Select
            className="w-[calc(50%-6px)] sm:w-40"
            label="Dependency"
            value={direct}
            onChange={setDirect}
            choices={options([
              ['all', 'All types'],
              ['true', 'Direct'],
              ['false', 'Transitive'],
            ])}
          />
        </div>
      </div>
      <p className="text-text-secondary text-xs">
        KEV: listed by CISA as exploited. EPSS: estimated exploitation probability, not proof of
        exploitation.
      </p>
      {body}
    </section>
  );
}
