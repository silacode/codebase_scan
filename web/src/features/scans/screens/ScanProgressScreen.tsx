import { Check, Circle, Link, X } from 'lucide-react';
import type { Scan } from '../types/scan-contracts';
import { Badge, Button, CopyButton, Notice, Panel, Progress } from '../../../components/ui';
import { ScanRepositoryIdentity } from '../components/ScanRepositoryIdentity';
import { date } from '../utils/report-formatters';

// Don't render the full event history.
const VISIBLE_EVENT_COUNT = 10;

const steps = [
  { name: 'Queued', stages: ['queued'], detail: 'Waiting for a worker to pick up this scan.' },
  {
    name: 'Download snapshot',
    stages: ['fetch'],
    detail: 'Fetching an exact commit, read-only. Nothing is installed or run.',
  },
  {
    name: 'Match packages to advisories',
    stages: ['scan_dependencies'],
    detail: 'Checking supported lockfile packages against OSV advisories.',
  },
  {
    name: 'Check for active exploitation',
    stages: ['enrich', 'classify'],
    detail: 'Checking optional exploit data and classifying the findings.',
  },
  {
    name: 'Rank fixes and explain them',
    stages: ['prioritize', 'explain', 'publish'],
    detail: 'Grouping findings by root cause, then ordering fixes by real risk.',
  },
];
export function ScanProgressScreen({
  data,
  cancel,
  cancelPending,
  connection,
}: {
  data: Scan;
  cancel: () => void;
  cancelPending: boolean;
  connection: string;
}) {
  const index = Math.max(
    0,
    steps.findIndex((step) => step.stages.includes(data.stage)),
  );
  const progress = Math.min(100, Math.max(0, Number.isFinite(data.progress) ? data.progress : 0));
  return (
    <div className="max-w-content mx-auto px-5 pt-8 pb-20 md:px-8 md:pt-10 xl:px-0">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <ScanRepositoryIdentity scan={data} />
        </div>
        <div className="flex items-center gap-3">
          <Badge level={data.status} />{' '}
          <Button variant="quiet" onClick={cancel} disabled={cancelPending}>
            {cancelPending ? 'Cancellation requested…' : 'Cancel scan'}{' '}
            <X aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </div>
      <h1 className="mt-9 max-w-4xl text-[clamp(32px,4vw,44px)] leading-[1.1] font-bold tracking-[-.035em]">
        {data.status === 'queued' ? 'Waiting for a scan slot' : steps[index].name}
      </h1>
      <p className="text-text-secondary mt-3 text-lg">
        You can leave this page. The link keeps working.
      </p>
      {cancelPending && (
        <p className="text-text-secondary mt-3 text-sm" role="status">
          Cancellation requested. Waiting for the server to confirm.
        </p>
      )}
      <div className="mt-8 max-w-4xl">
        <div className="flex justify-between text-sm font-semibold">
          <span>Scan progress</span>
          <span>{progress}%</span>
        </div>
        <Progress.Root
          aria-label="Scan progress"
          max={100}
          value={progress}
          className="rounded-pill bg-low-tint mt-3 inline-block h-2 w-full overflow-hidden align-baseline"
        >
          <Progress.Track className="h-full">
            <Progress.Indicator className="bg-primary" />
          </Progress.Track>
        </Progress.Root>
        {data.status === 'queued' && data.queuePosition !== null && (
          <p className="text-text-secondary mt-2 text-sm">
            Queue position: {data.queuePosition + 1}
          </p>
        )}
      </div>
      {connection && (
        <div className="mt-6">
          <Notice>{connection}</Notice>
        </div>
      )}
      <div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,696px)_minmax(0,440px)] lg:gap-12">
        <ol className="space-y-2">
          {steps.map((step, n) => (
            <li
              key={step.name}
              className={`flex min-w-0 items-start gap-4 p-5 ${n === index ? 'border-primary bg-surface rounded-lg border shadow-sm' : 'border-border border-b'}`}
            >
              <span
                className={`flex size-8 shrink-0 items-center justify-center rounded-full ${n <= index ? 'bg-primary text-white' : 'bg-low-tint text-text-muted'}`}
              >
                {n < index ? (
                  <Check aria-hidden="true" className="size-4" />
                ) : (
                  <Circle aria-hidden="true" className="size-4" />
                )}
              </span>
              <div className="min-w-0">
                <h2 className="font-semibold">{step.name}</h2>
                <p className="text-text-secondary mt-1 text-sm leading-6">
                  {n === index && data.events.at(-1)?.stage === data.stage
                    ? `${step.detail} ${data.events.at(-1)?.message ?? ''}`
                    : step.detail}
                </p>
              </div>
            </li>
          ))}
        </ol>
        <aside className="space-y-5">
          <Panel as="section" className="p-5">
            <h2 className="text-lg font-semibold">Live activity</h2>
            <ol className="mt-4 max-h-80 space-y-3 overflow-y-auto text-sm">
              {data.events.length ? (
                data.events
                  .slice(-VISIBLE_EVENT_COUNT)
                  .reverse()
                  .map((event) => (
                    <li key={event.seq} className="border-border border-b pb-2">
                      <time dateTime={event.at} className="text-text-muted font-mono text-xs">
                        {date(event.at)}
                      </time>
                      <p className="mt-1 break-words">{event.message}</p>
                    </li>
                  ))
              ) : (
                <li className="text-text-secondary">Waiting for updates…</li>
              )}
            </ol>
          </Panel>
          <Panel as="section" className="p-5">
            <h2 className="flex items-center gap-2 font-semibold">
              <Link aria-hidden="true" className="size-4" /> Come back anytime
            </h2>
            <p className="text-text-secondary mt-2 text-sm">
              Keep this link to see progress or share the report.
            </p>
            <CopyButton
              value={location.href}
              label="Copy scan link"
              text="Copy link"
              className="mt-3"
            />
          </Panel>
        </aside>
      </div>
    </div>
  );
}
