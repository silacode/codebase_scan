-- Bootstrap DDL for the application's own tables. Applied by migrate.ts at every
-- startup under an advisory lock; every statement is idempotent (IF NOT EXISTS), so
-- re-running is safe. Additive changes go in migrate.ts, not by editing history here.
-- src/db/schema.ts mirrors these tables for typed Drizzle access; pg-boss owns its
-- queue tables separately and they never appear in this file.

-- One row per scan submission. scan_key (owner/repo@sha#scanner-version) plus the
-- partial unique index below allows only one active scan per commit; a completed
-- report is stored inline in report when the scan publishes.
CREATE TABLE IF NOT EXISTS scans (
 id uuid PRIMARY KEY, owner text NOT NULL, repo text NOT NULL, ref text NOT NULL,
 commit_sha text NOT NULL, repo_size_kb int NOT NULL, scan_key text NOT NULL,
 status text NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
 stage text NOT NULL DEFAULT 'queued', progress int NOT NULL DEFAULT 0,
 attempt int NOT NULL DEFAULT 0, queue_job_id uuid,
 cancel_requested boolean NOT NULL DEFAULT false, event_seq int NOT NULL DEFAULT 0,
 client_ip text, error jsonb, report jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS scans_active_key ON scans(scan_key) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS scans_status_created ON scans(status, created_at);
-- Per-stage outputs and checkpoints; retries resume completed stages instead of redoing them.
CREATE TABLE IF NOT EXISTS scan_stages (
 scan_id uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE, stage text NOT NULL,
 output jsonb, outcome text CHECK (outcome IN ('ok','partial','failed','skipped')),
 started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz, error text,
 PRIMARY KEY (scan_id, stage)
);
-- Ordered progress log per scan; seq drives SSE replay and the stored event history.
CREATE TABLE IF NOT EXISTS scan_events (
 scan_id uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE, seq int NOT NULL,
 at timestamptz NOT NULL DEFAULT now(), stage text NOT NULL,
 level text NOT NULL CHECK (level IN ('info','warn','error')), message text NOT NULL,
 PRIMARY KEY(scan_id,seq)
);
-- Normalized vulnerability findings; severity_rank keeps evidence queries pre-sorted.
CREATE TABLE IF NOT EXISTS findings (
 scan_id uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE, finding_id text NOT NULL,
 severity_rank int NOT NULL, data jsonb NOT NULL, PRIMARY KEY(scan_id,finding_id)
);
-- Root-cause issues grouped from findings; priority keeps the fix plan pre-sorted.
CREATE TABLE IF NOT EXISTS issues (
 scan_id uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE, issue_id text NOT NULL,
 priority double precision NOT NULL, data jsonb NOT NULL, PRIMARY KEY(scan_id,issue_id)
);
-- Idempotency-Key replays: stored responses keyed by request hash, with a TTL.
CREATE TABLE IF NOT EXISTS idempotency_keys (
 key text PRIMARY KEY, request_hash text NOT NULL, scan_id uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
 status_code int NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
-- Shared scanner cache (OSV advisories, KEV/EPSS, Jev answers); expires_at is checked on read.
CREATE TABLE IF NOT EXISTS cache (key text PRIMARY KEY, value jsonb NOT NULL, expires_at timestamptz NOT NULL);
