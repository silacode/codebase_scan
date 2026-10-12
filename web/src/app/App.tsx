import { useState, type ReactNode } from 'react';
import { Notice } from '../components/ui';
import { AppLayout } from '../components/layout/AppLayout';
import { NewScanScreen } from '../features/scans/screens/NewScanScreen';
import { ScanProgressScreen } from '../features/scans/screens/ScanProgressScreen';
import { ScanReportScreen } from '../features/scans/screens/ScanReportScreen';
import { ScanStatusScreen } from '../features/scans/screens/ScanStatusScreen';
import { useScanController } from '../features/scans/hooks/useScanController';

export default function App() {
  const {
    id,
    data,
    loading,
    pending,
    attempt,
    cancelPending,
    cancelError,
    error,
    connection,
    navigate,
    start,
    cancel,
    retry,
  } = useScanController();
  const [prefill, setPrefill] = useState<{ url: string; ref: string } | undefined>();
  const home = (prefillRepo = false) => {
    setPrefill(
      prefillRepo && data
        ? { url: `https://github.com/${data.owner}/${data.repo}`, ref: data.ref }
        : undefined,
    );
    navigate('');
  };
  const submit = (url: string, ref: string, force: boolean) => {
    setPrefill(undefined);
    void start(url, ref, force);
  };
  const rescan = () => {
    if (data) void start(`https://github.com/${data.owner}/${data.repo}`, data.ref, true);
  };

  if (!id) {
    const initial = prefill ?? (error && attempt ? attempt : undefined);
    return (
      <AppLayout id={id} onHome={() => home()}>
        <NewScanScreen
          key={prefill?.url ?? (error && attempt?.url) ?? 'new'}
          initial={initial}
          onScan={submit}
          pending={pending}
          error={error}
        />
      </AppLayout>
    );
  }

  if (!data)
    return (
      <AppLayout id={id} onHome={() => home()}>
        <ScanStatusScreen
          data={data}
          loading={loading}
          error={error}
          retry={retry}
          home={home}
          rescan={rescan}
        />
      </AppLayout>
    );

  const active = ['queued', 'running'].includes(data.status);
  const reportable = data.status === 'completed' && data.report !== null;
  let view: ReactNode;
  if (active)
    view = (
      <ScanProgressScreen
        data={data}
        cancel={() => void cancel()}
        cancelPending={cancelPending}
        connection={connection}
      />
    );
  else if (reportable) view = <ScanReportScreen key={id} scan={data} rescan={rescan} />;
  else
    view = (
      <ScanStatusScreen
        data={data}
        loading={loading}
        error={error}
        retry={retry}
        home={home}
        rescan={rescan}
      />
    );

  return (
    <AppLayout id={id} onHome={() => home()}>
      {(error || cancelError) && (
        <div className="max-w-content mx-auto mt-5 px-5">
          <Notice error>{cancelError || error}</Notice>
        </div>
      )}
      {view}
    </AppLayout>
  );
}
