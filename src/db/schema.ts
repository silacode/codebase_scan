import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  doublePrecision,
  primaryKey,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { Finding } from '../scanners/scanner-types.ts';
import type { Issue } from '../reports/issue-types.ts';

// Scan lifecycle: queued → running (worker claim) → completed | failed | cancelled, with
// attempt-scoped fencing (see scans/scan-attempt-store.ts) and per-stage rows so redelivery resumes.

type Status = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
type Outcome = 'ok' | 'partial' | 'failed' | 'skipped';
type Level = 'info' | 'warn' | 'error';
const time = (name: string) => timestamp(name, { withTimezone: true });
export const scans = pgTable(
  'scans',
  {
    // scanKey = owner/repo@sha#scannerVersion; completed scans of a key are reused rather
    // than rescanned. The partial unique index below enforces one *active* scan per key.
    id: uuid().primaryKey(),
    owner: text().notNull(),
    repo: text().notNull(),
    ref: text().notNull(),
    commitSha: text('commit_sha').notNull(),
    repoSizeKb: integer('repo_size_kb').notNull(),
    scanKey: text('scan_key').notNull(),
    status: text().$type<Status>().notNull(),
    stage: text().notNull().default('queued'),
    progress: integer().notNull().default(0),
    attempt: integer().notNull().default(0),
    queueJobId: uuid('queue_job_id'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    // Monotonic per-scan counter; emitEvent bumps it so SSE consumers never see reordering.
    eventSeq: integer('event_seq').notNull().default(0),
    clientIp: text('client_ip'),
    error: jsonb().$type<{ code: string; message: string; retryable: boolean }>(),
    report: jsonb().$type<ReturnType<typeof import('../reports/report-builder.ts').buildReport>>(),
    createdAt: time('created_at').notNull().defaultNow(),
    startedAt: time('started_at'),
    finishedAt: time('finished_at'),
  },
  (t) => [
    uniqueIndex('scans_active_key')
      .on(t.scanKey)
      .where(sql`${t.status} IN ('queued','running')`),
    index('scans_status_created').on(t.status, t.createdAt),
    check(
      'scans_status_check',
      sql`${t.status} IN ('queued','running','completed','failed','cancelled')`,
    ),
  ],
);
// One row per (attempt, stage): the upsert in saveStage is what lets a redelivered attempt
// resume here instead of redoing finished stages.
export const scanStages = pgTable(
  'scan_stages',
  {
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    stage: text().notNull(),
    output: jsonb(),
    outcome: text().$type<Outcome>(),
    startedAt: time('started_at').notNull().defaultNow(),
    endedAt: time('ended_at'),
    error: text(),
  },
  (t) => [
    primaryKey({ columns: [t.scanId, t.stage] }),
    check('scan_stages_outcome_check', sql`${t.outcome} IN ('ok','partial','failed','skipped')`),
  ],
);
// Append-only progress log; emitEvent notifies 'scan_events' for SSE push.
export const scanEvents = pgTable(
  'scan_events',
  {
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    seq: integer().notNull(),
    at: time('at').notNull().defaultNow(),
    stage: text().notNull(),
    level: text().$type<Level>().notNull(),
    message: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scanId, t.seq] }),
    check('scan_events_level_check', sql`${t.level} IN ('info','warn','error')`),
  ],
);
// Raw findings and prioritized issues per scan; rank/priority columns drive list order.
export const findings = pgTable(
  'findings',
  {
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    findingId: text('finding_id').notNull(),
    severityRank: integer('severity_rank').notNull(),
    data: jsonb().$type<Finding>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.scanId, t.findingId] })],
);
export const issues = pgTable(
  'issues',
  {
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    issueId: text('issue_id').notNull(),
    priority: doublePrecision().notNull(),
    data: jsonb().$type<Issue>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.scanId, t.issueId] })],
);
// HTTP Idempotency-Key replays: stored responses keyed by request hash, with a TTL.
export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text().primaryKey(),
  requestHash: text('request_hash').notNull(),
  scanId: uuid('scan_id')
    .notNull()
    .references(() => scans.id, { onDelete: 'cascade' }),
  statusCode: integer('status_code').notNull(),
  response: jsonb().notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
});
// Upstream cache (OSV details, KEV, EPSS, registry metadata, Jev/AI answers) with expiry.
export const cache = pgTable('cache', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  expiresAt: time('expires_at').notNull(),
});
export type Scan = typeof scans.$inferSelect;
