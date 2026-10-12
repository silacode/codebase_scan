/** One vulnerable version of one package in one lockfile. */
export interface Finding {
  id: string;
  category: 'dependency';
  advisoryId: string;
  aliases: string[];
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  package: string;
  version: string;
  lockfile: string;
  direct: boolean;
  dev: boolean;
  introducedBy: string[];
  introducerDev?: boolean;
  introducerWorkspaces?: string[];
  path: string[];
  parent?: { name: string; range: string };
  fixedVersion?: string;
  cweIds: string[];
  references: string[];
  exploit?: { kev?: boolean; epss?: number; epssPercentile?: number };
  context?: { impactClass: string; source: 'rules' | 'jev'; confidence?: number };
}
/** The DB-backed key/value cache adapters share. */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
}
/** What adapters get: workspace, pinned repo, abort signal, progress reporting, cache. */
export interface ScanContext {
  workspaceDir: string;
  repo: { owner: string; repo: string; commitSha: string };
  signal: AbortSignal;
  progress(message: string): Promise<void>;
  cache: Cache;
}
/** Adapters return findings plus honest coverage of what was not scanned, and stats. */
export interface AdapterResult {
  findings: Finding[];
  coverage: { scanned: string[]; notScanned: { what: string; why: string }[] };
  stats: Record<string, number>;
}
/** A pluggable scanner; the worker runs every registered adapter per scan. */
export interface ScannerAdapter {
  name: string;
  category: 'dependency' | 'secret' | 'ci_config' | 'code';
  timeoutMs: number;
  resourceClass: 'light' | 'heavy';
  run(ctx: ScanContext): Promise<AdapterResult>;
}
