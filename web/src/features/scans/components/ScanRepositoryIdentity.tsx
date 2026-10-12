import { GitBranch } from 'lucide-react';
import type { Scan } from '../types/scan-contracts';
import { SHORT_COMMIT_LENGTH } from '../utils/report-formatters';

export function ScanRepositoryIdentity({
  scan,
}: {
  scan: Pick<Scan, 'owner' | 'repo' | 'ref' | 'commitSha'>;
}) {
  return (
    <>
      <strong className="max-w-full min-w-0 text-lg break-all">
        {scan.owner}/{scan.repo}
      </strong>
      <span className="rounded-pill border-border bg-surface inline-flex max-w-full min-w-0 items-center gap-1 border px-2 py-1 font-mono text-xs">
        <span className="sr-only">Ref:</span>
        <GitBranch aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 break-all">{scan.ref}</span>
      </span>
      {scan.commitSha && (
        <span className="rounded-pill border-border bg-surface border px-2 py-1 font-mono text-xs">
          {scan.commitSha.slice(0, SHORT_COMMIT_LENGTH)}
        </span>
      )}
    </>
  );
}
