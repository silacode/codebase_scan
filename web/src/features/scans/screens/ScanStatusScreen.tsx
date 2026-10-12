import { Button, Notice } from '../../../components/ui';
import type { Scan } from '../types/scan-contracts';

export function ScanStatusScreen({
  data,
  loading,
  error,
  retry,
  home,
  rescan,
}: {
  data: Scan | null;
  loading: boolean;
  error: string;
  retry: () => void;
  home: (prefill?: boolean) => void;
  rescan: () => void;
}) {
  if (loading && !data)
    return (
      <main className="max-w-content mx-auto px-5 py-20" role="status">
        Loading scan…
      </main>
    );
  if (error && !data)
    return (
      <main className="max-w-content mx-auto space-y-5 px-5 py-20">
        <h1 className="text-3xl font-bold">Scan unavailable</h1>
        <Notice error>{error}</Notice>
        <Button onClick={retry}>Retry loading scan</Button>
        <Button onClick={() => home()}>New scan</Button>
      </main>
    );
  if (!data) return null;
  if (data.status === 'completed')
    return (
      <main className="max-w-content mx-auto space-y-4 px-5 py-20">
        <h1 className="text-3xl font-bold">Report unavailable</h1>
        <Notice error>
          The scan completed, but its report is not available. This is not a clean result.
        </Notice>
        <Button onClick={rescan}>Rescan repository</Button>
      </main>
    );
  let detail = 'The scan stopped before a report was published.';
  if (data.error) detail = `${data.error.code}: ${data.error.message}`;
  else if (data.status === 'cancelled') detail = 'This scan was cancelled.';
  return (
    <main className="max-w-content mx-auto space-y-5 px-5 py-20">
      <h1 className="text-3xl font-bold">
        Scan {data.status === 'cancelled' ? 'cancelled' : 'failed'}
      </h1>
      <Notice error>{detail}</Notice>
      <p className="text-text-secondary">
        {data.error?.retryable
          ? 'You can retry this scan.'
          : 'Check the cause before trying again.'}
      </p>
      <div className="flex flex-wrap gap-3">
        <Button variant="primary" onClick={rescan}>
          Retry scan
        </Button>
        <Button onClick={() => home(true)}>Change repository</Button>
      </div>
    </main>
  );
}
