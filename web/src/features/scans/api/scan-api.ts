import { request } from '../../../api/http-client';
import type { Scan, Issue, Finding } from '../types/scan-contracts';

export const getScan = (id: string, signal?: AbortSignal) =>
  request<Scan>(`/api/scans/${encodeURIComponent(id)}`, { signal });

export const getScanIssues = (id: string, signal?: AbortSignal) =>
  request<{ items: Issue[] }>(`/api/scans/${encodeURIComponent(id)}/issues`, { signal });

export const cancelScan = (id: string) =>
  request<{ id: string; status: string }>(`/api/scans/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  });

export const submitScan = (repoUrl: string, ref: string, force: boolean, signal?: AbortSignal) =>
  request<Scan>('/api/scans', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ repoUrl, ...(ref ? { ref } : {}), force }),
  });

export const getScanFindings = (id: string, params: URLSearchParams, signal?: AbortSignal) =>
  request<{ items: Finding[]; total: number }>(
    `/api/scans/${encodeURIComponent(id)}/findings?${params}`,
    { signal },
  );
