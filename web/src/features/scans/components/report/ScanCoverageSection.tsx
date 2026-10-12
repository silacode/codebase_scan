import { ExternalLink } from 'lucide-react';
import type { Report } from '../../types/scan-contracts';
import { date } from '../../utils/report-formatters';
import { Panel } from '../../../../components/ui';

export function ScanCoverageSection({ report }: { report: Report }) {
  const { coverage, provenance } = report;
  const commit = provenance.commitSha;
  return (
    <section className="grid gap-12 py-10 lg:grid-cols-[minmax(0,760px)_minmax(0,392px)]">
      <div className="min-w-0">
        <h2 className="text-[28px] font-bold tracking-[-.02em]">What was, and wasn't, scanned</h2>
        <p className="text-text-secondary mt-2 text-sm">
          Only npm lockfiles from the exact commit below. Coverage gaps do not mean a repository is
          secure.
        </p>
        <section className="border-border bg-surface mt-8 overflow-hidden rounded-lg border">
          <h3 className="border-border bg-low-tint border-b px-6 py-4 text-sm font-semibold tracking-wide uppercase">
            Scanned · {coverage.scanned?.length ?? 0} lockfiles
          </h3>
          {coverage.scanned?.length ? (
            <ul>
              {coverage.scanned.map((path, i) => (
                <li
                  key={`${path}-${i}`}
                  className="border-border border-b px-6 py-4 font-mono text-sm break-all last:border-b-0"
                >
                  {path}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-text-secondary p-6 text-sm">No supported lockfile was scanned.</p>
          )}
        </section>
        <section className="border-border bg-surface mt-5 overflow-hidden rounded-lg border">
          <h3 className="border-border bg-low-tint border-b px-6 py-4 text-sm font-semibold tracking-wide uppercase">
            Not scanned · {coverage.notScanned?.length ?? 0}
          </h3>
          {coverage.notScanned?.length ? (
            <ul>
              {coverage.notScanned.map((gap, i) => (
                <li
                  key={`${gap.what}-${i}`}
                  className="border-border border-b px-6 py-4 text-sm break-words last:border-b-0"
                >
                  <strong>{gap.what}</strong>
                  <p className="text-text-secondary mt-1">{gap.why}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-text-secondary p-6 text-sm">No coverage gaps recorded.</p>
          )}
        </section>
      </div>
      <Panel as="aside" className="h-fit min-w-0">
        <h3 className="text-lg font-semibold">Where this report came from</h3>
        <dl className="mt-5 space-y-4 text-sm">
          {[
            ['Repository', `${provenance.owner}/${provenance.repo}`],
            ['Ref', provenance.ref || 'Not recorded'],
            ['Scanner', provenance.scannerVersion || 'Not recorded'],
            ['Advisory data', date(provenance.advisoryDataAt)],
            ['KEV catalog', date(provenance.kevCatalogAt)],
            ['Scan completed', date(provenance.scannedAt)],
            ['Classification', report.classifier?.source ?? 'Not recorded'],
          ].map(([label, value]) => (
            <div
              key={label}
              className="border-border flex flex-wrap justify-between gap-2 border-b pb-3"
            >
              <dt className="text-text-muted">{label}</dt>
              <dd className="min-w-0 font-medium break-all">{value}</dd>
            </div>
          ))}
          <div className="border-border border-b pb-3">
            <dt className="text-text-muted">Exact commit</dt>
            <dd className="mt-1 font-mono break-all">
              {commit ? (
                <a
                  href={`https://github.com/${encodeURIComponent(provenance.owner)}/${encodeURIComponent(provenance.repo)}/commit/${encodeURIComponent(commit)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {commit} <ExternalLink aria-label="Opens in new tab" className="inline size-4" />
                </a>
              ) : (
                'Not recorded'
              )}
            </dd>
          </div>
        </dl>
        <p className="bg-primary-tint text-text-secondary mt-6 rounded-md p-4 text-sm">
          The same commit, scanner and advisory data produce a reproducible snapshot. Advisory
          sources can change after this scan.
        </p>
      </Panel>
    </section>
  );
}
