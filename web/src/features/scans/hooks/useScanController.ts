import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cancelScan, getScan, submitScan } from '../api/scan-api';
import type { Scan } from '../types/scan-contracts';
import { scanIdentity, useScanNavigation } from './useScanNavigation';
import { message } from '../utils/report-formatters';

// Until the server confirms a terminal state.
const CANCELLATION_POLL_INTERVAL_MS = 1_000;
const TERMINAL = ['completed', 'failed', 'cancelled'];

/**
 * Screen-state orchestrator: scan id from the URL, snapshot query with SSE invalidation
 * (plus polling while a cancel is pending), submit/cancel mutations, and the
 * submit-only cached/deduplicated flags merged into snapshot data.
 */
export function useScanController() {
  const queryClient = useQueryClient();
  const [id, setId] = useState(scanIdentity);
  const [attempt, setAttempt] = useState<{ url: string; ref: string; force: boolean } | null>(null);
  const [extras, setExtras] = useState<{ cached?: boolean; deduplicated?: boolean }>({});
  const [cancelRequested, setCancelRequested] = useState(false);
  const [connection, setConnection] = useState('');

  const transition = useCallback(
    (next: string, initial?: Scan) => {
      if (initial) {
        setExtras({ cached: initial.cached, deduplicated: initial.deduplicated });
        queryClient.setQueryData(['scan', next], initial);
      } else {
        setExtras({});
      }
      setCancelRequested(false);
      setConnection('');
      setId(next);
    },
    [queryClient],
  );
  const { navigate, clearUrl } = useScanNavigation(transition);

  const scanQuery = useQuery({
    queryKey: ['scan', id],
    queryFn: ({ signal }) => getScan(id, signal),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return cancelRequested && status && !TERMINAL.includes(status)
        ? CANCELLATION_POLL_INTERVAL_MS
        : false;
    },
  });
  const status = scanQuery.data?.status;
  const terminal = !!status && TERMINAL.includes(status);
  useEffect(() => {
    if (terminal) setCancelRequested(false);
  }, [terminal]);

  // Live progress: any SSE signal just refetches the snapshot, the source of truth.
  useEffect(() => {
    if (!id || (status && TERMINAL.includes(status))) return;
    const stream = new EventSource(`/api/scans/${encodeURIComponent(id)}/events`);
    const refresh = () => void queryClient.invalidateQueries({ queryKey: ['scan', id] });
    stream.addEventListener('progress', refresh);
    stream.addEventListener('end', () => {
      stream.close();
      refresh();
    });
    stream.onerror = () => setConnection('Connection interrupted; reconnecting…');
    return () => stream.close();
  }, [id, status, queryClient]);

  const submit = useMutation({
    mutationFn: ({ url, ref, force }: { url: string; ref: string; force: boolean }) =>
      submitScan(url, ref, force),
    onSuccess: (result) => navigate(result.id, true, result),
  });
  const cancellation = useMutation({
    mutationFn: (target: string) => cancelScan(target),
    onSuccess: (_data, target) =>
      void queryClient.invalidateQueries({ queryKey: ['scan', target] }),
    onError: () => setCancelRequested(false),
  });

  const start = useCallback(
    (url: string, ref: string, force: boolean) => {
      if (submit.isPending) return;
      setAttempt({ url, ref, force });
      setId('');
      clearUrl();
      submit.mutate({ url, ref, force });
    },
    [submit, clearUrl],
  );
  const cancel = useCallback(() => {
    if (!id || cancelRequested || cancellation.isPending) return;
    setCancelRequested(true);
    cancellation.mutate(id);
  }, [id, cancelRequested, cancellation]);

  const data = scanQuery.data ? { ...scanQuery.data, ...extras } : null;
  let error = '';
  if (submit.isError) error = message(submit.error);
  else if (scanQuery.isError) error = message(scanQuery.error);
  return {
    id,
    data,
    loading: !!id && scanQuery.isPending,
    pending: submit.isPending,
    attempt,
    cancelPending: cancelRequested || cancellation.isPending,
    cancelError: cancellation.isError ? message(cancellation.error) : '',
    error,
    connection,
    navigate,
    start,
    cancel,
    retry: () => void scanQuery.refetch(),
  };
}
