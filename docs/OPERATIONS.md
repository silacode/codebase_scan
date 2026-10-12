# Operations

## Environment

Copy `.env.example` if running outside Compose; Compose passes through the optional keys. Variables are parsed at startup:

| Variable           | Default                                    | Purpose                             |
| ------------------ | ------------------------------------------ | ----------------------------------- |
| `DATABASE_URL`     | `postgres://scan:scan@localhost:5433/scan` | PostgreSQL connection               |
| `PORT`             | `8080`                                     | HTTP listen port                    |
| `ROLE`             | `all`                                      | `api`, `worker`, or both            |
| `WORKER_SLOTS`     | `4`                                        | Concurrent scans per worker process |
| `MAX_QUEUED`       | `32`                                       | Queue load-shedding threshold       |
| `GITHUB_TOKEN`     | unset                                      | Optional GitHub REST bearer token   |
| `OPENAI_API_KEY`   | unset                                      | Optional explanation service        |
| `OPENAI_MODEL`     | `gpt-5-mini`                               | OpenAI model                        |
| `TYPESAFE_API_KEY` | unset                                      | Optional Jev classifier             |
| `TYPESAFE_MODEL`   | `jev-1.13.0`                               | Jev choice model                    |
| `LOG_LEVEL`        | `info`                                     | `trace`–`fatal` log verbosity       |

## Idempotency, deduplication, and concurrency

- An `Idempotency-Key` (1–200 characters) replays the **original status and response** for the same normalized request for 24 hours.
- A different request using that key returns 422; simultaneous requests using it within one API process return 409.
- The same commit and scanner version can have only one active scan (partial unique index); a successful result is reused for 24 hours unless `force` is set.
- The default per-IP limits are three active scans and ten submissions/minute; exceeding them returns 429 with `Retry-After`. These are API-factory options for tests only, not an exception for duplicates.
- Errors always have `{ "error": { "code": "...", "message": "...", "retryable": false } }`. Requests larger than 16 KB return 413.

## Queue and roles

PostgreSQL holds application scans and pg-boss's own queue schema; completed reports stay in the application tables. Drizzle maps the seven application tables in `src/db/schema.ts` and owns normal application reads/writes. The guarded, idempotent `src/db/schema.sql` remains the bootstrap DDL for fresh and existing databases; it does not own pg-boss's tables. Event sequencing/NOTIFY, migrations, advisory locks and metrics keep parameterized SQL where the database operation requires it. A new scan and its queue job commit in one Drizzle transaction via pg-boss's `fromDrizzle` adapter. pg-boss dispatches up to `WORKER_SLOTS` jobs per worker process, polling every 2 seconds; its 30-second heartbeat refreshes every 10 seconds and a 10-second supervisor checks for dead workers. Jobs retry twice after the initial attempt (up to three executions), with exponential backoff capped at 5 seconds; a finalization queue closes scans whose workers exhaust retries through crashes. Each attempt has a 330-second hard bound, above the scan's original 300-second total deadline. Workers resume completed stage checkpoints and reject stale writes with application and queue-attempt fences. Cancellation commits with queue cancellation and ends the scan even when its worker is gone. The API's shared `LISTEN scan_events` connection distributes progress to SSE clients. `ROLE=api` serves HTTP only, `ROLE=worker` consumes jobs without HTTP, and `ROLE=all` does both.

**Upgrade from the old queue:** pause submissions, let all queued/running scans drain (or cancel them using the old app), stop every old API/worker process, recheck for active scans, and back up PostgreSQL before restarting any process with pg-boss. Startup refuses active legacy scans with no queue job; never run the old and new workers together. The migration preserves terminal reports and removes only the obsolete lease columns. No Redis or new service is required.

## AI, provenance, and security

- Template explanations always exist. OpenAI receives only bounded structured facts for the top 25 Issues, not repository files. Its JSON-schema response is validated and may replace explanation text only; it cannot change advisories, severity, versions, scores or fix commands. Missing keys, errors and timeouts use the template.
- Jev is limited to repository type and otherwise-unclassified advisory impact; confidence below 0.6 or an outage uses rules. The UI labels which source produced text.
- Reports link the exact commit and record scanner version, advisory lookup time, optional KEV catalog time, scan time and coverage gaps.
- Outbound URLs are built from validated GitHub owner/repo/ref and fixed provider endpoints, not supplied by users.
- The tar extractor rejects links and unsafe paths, caps file count/bytes, and skips files above 5 MB except npm lockfiles (20 MB).
- Optional credentials come from environment variables and are never included in logs.
- No private repositories, authentication, or code execution are provided. This is a read-only **dependency** scan; it is not a sandbox suitable for executing arbitrary repositories.

## Limits

- GitHub metadata size limit is 1 GB; the extracted snapshot is bounded by 100,000 files and 2 GB.
- Non-lockfiles over 5 MB and npm lockfiles over 20 MB are skipped and reported in coverage.
- At most 20,000 packages per scan are examined; the body limit is 16 KB; a scan has a 300-second deadline.
- Four worker slots and 32 queued jobs are defaults. With no token, GitHub's unauthenticated quota dominates.
- No production load or chaos benchmark has been run for this version.

## Not in v1

No auth or multi-tenancy, private repositories/GitHub App, PR-triggered rescans, scan diffs, auto-fix PRs, reachability analysis, other ecosystems, secret/CI/code scanners, or suppression UI. Yarn and pnpm lockfiles are explicitly marked as unsupported in coverage.
