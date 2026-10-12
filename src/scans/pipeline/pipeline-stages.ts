import { DEPENDENCY_SCAN_TIMEOUT_MS } from '../../config.ts';

export type Stage =
  'fetch' | 'scan_dependencies' | 'enrich' | 'classify' | 'prioritize' | 'explain';

/** Bound stage work and set ordered completion percentages, not live progress estimates. */
export const stages: { name: Stage; progress: number; timeoutMs: number; optional: boolean }[] = [
  { name: 'fetch', progress: 15, timeoutMs: 60_000, optional: false },
  {
    name: 'scan_dependencies',
    progress: 45,
    timeoutMs: DEPENDENCY_SCAN_TIMEOUT_MS,
    optional: false,
  },
  { name: 'enrich', progress: 60, timeoutMs: 20_000, optional: true },
  { name: 'classify', progress: 70, timeoutMs: 20_000, optional: true },
  { name: 'prioritize', progress: 85, timeoutMs: 30_000, optional: false },
  { name: 'explain', progress: 95, timeoutMs: 30_000, optional: true },
];
