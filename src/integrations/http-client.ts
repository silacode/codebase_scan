import { constants as HTTP } from 'node:http2';
import { FetchError, ofetch } from 'ofetch';
import { ScanError } from '../errors.ts';

const DEFAULT_UPSTREAM_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 500;
// Avoid synchronized retries.
const BACKOFF_JITTER_MS = 250;
const MAX_RESPONSE_BACKOFF_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
/** Retry-After (seconds or HTTP date, capped at 5s) or jittered exponential backoff. */
function retryDelay(attempt: number, response?: Response) {
  const header = response?.headers.get('retry-after');
  let retryAfter = NaN;
  if (header)
    retryAfter = Number.isFinite(Number(header))
      ? Number(header) * 1000
      : Date.parse(header) - Date.now();
  if (Number.isFinite(retryAfter) && retryAfter > 0)
    return Math.min(MAX_RESPONSE_BACKOFF_MS, retryAfter);
  return Math.min(
    MAX_RESPONSE_BACKOFF_MS,
    INITIAL_BACKOFF_MS * 2 ** attempt + Math.random() * BACKOFF_JITTER_MS,
  );
}
/**
 * fetch with per-attempt timeout and bounded retries: retries 429/5xx and network errors
 * up to `attempts` (default 3), honoring Retry-After (capped at 5s), otherwise jittered
 * exponential backoff. Non-retryable statuses are returned as-is for the caller to classify.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: { timeoutMs: number; attempts?: number; signal?: AbortSignal },
): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < (options.attempts ?? DEFAULT_UPSTREAM_ATTEMPTS); i++) {
    const signal = AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs),
      ...(options.signal ? [options.signal] : []),
    ]);
    try {
      const response = await fetch(url, { ...init, signal });
      if (response.ok) return response;
      if (
        response.status !== HTTP.HTTP_STATUS_TOO_MANY_REQUESTS &&
        response.status < HTTP.HTTP_STATUS_INTERNAL_SERVER_ERROR
      )
        return response;
      last = response;
      if (i === (options.attempts ?? DEFAULT_UPSTREAM_ATTEMPTS) - 1) return response;
      await response.body?.cancel();
      await wait(retryDelay(i, response), options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      last = error;
      if (i === (options.attempts ?? DEFAULT_UPSTREAM_ATTEMPTS) - 1) throw error;
      await wait(INITIAL_BACKOFF_MS * 2 ** i + Math.random() * BACKOFF_JITTER_MS, options.signal);
    }
  }
  if (last instanceof Response) return last;
  throw new ScanError('UPSTREAM_UNAVAILABLE', 'Upstream unavailable', true);
}
/** ofetch single-attempt JSON; retries with abort-aware backoff, non-2xx → ScanError. */
export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  options: { timeoutMs: number; attempts?: number; signal?: AbortSignal } = {
    timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  },
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_UPSTREAM_ATTEMPTS;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    const signal = AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs),
      ...(options.signal ? [options.signal] : []),
    ]);
    try {
      return await ofetch<T>(url, { ...init, signal, retry: false });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      const response = error instanceof FetchError ? error.response : undefined;
      const status = response?.status;
      if (status !== undefined && status !== HTTP.HTTP_STATUS_TOO_MANY_REQUESTS && status < 500)
        throw new ScanError('UPSTREAM_UNAVAILABLE', `Upstream returned ${status}`, false);
      last = error;
      if (i === attempts - 1) break;
      await wait(retryDelay(i, response), options.signal);
    }
  }
  const status = last instanceof FetchError ? last.response?.status : undefined;
  if (status !== undefined)
    throw new ScanError('UPSTREAM_UNAVAILABLE', `Upstream returned ${status}`, true);
  throw last instanceof Error
    ? last
    : new ScanError('UPSTREAM_UNAVAILABLE', 'Upstream failed', true);
}
