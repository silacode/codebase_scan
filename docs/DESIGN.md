# AI Scan Review: requirements and architecture (v1)

This document fixes the product contract, the architecture, and the targets that tools have to fit into. Specific tools (scanners, advisory sources, classifier, LLM) are chosen later against the criteria in §7.

A visual version of this document is in [`design.html`](design.html).

## 1. Problem and product principles

| | |
|---|---|
| **User need** | "Am I exposed, and what do I fix first?" The user wants a decision, not a dataset. |
| **Problem** | Raw scanner output is hundreds of duplicated rows with no context, ranked by CVSS. Users tune it out and nothing gets fixed. |
| **Root cause** | Scanners report symptoms (vulnerability × package × dependency path), not causes. Severity is not the same as risk. Nothing links a finding to an action. |
| **Product response** | Group findings into root-cause **Issues** (problem, root cause, fix, evidence). Rank them by real risk. Give the user an ordered action plan. |

- **P1:** Show Issues, not findings. Findings are the evidence behind an Issue.
- **P2:** Rules and calibrated classifiers decide. The LLM only explains, and it can be switched off.
- **P3:** Every report is reproducible and states where it came from: commit SHA, scanner version, advisory-data timestamp, and what was and wasn't scanned.
- **P4:** Degrade instead of failing. If an optional component breaks, the user gets a partial, labeled result.

## 2. Scope (v1)

**In scope:**
- Public GitHub repos by URL, with an optional branch, tag or SHA. Works without a token at 60 req/h (demo only); production needs a server-side GitHub token.
- Dependency scanning for one ecosystem (npm lockfile). Secrets, CI/CD config and code scanning plug in through the same adapter contract.
- Asynchronous scans with live progress, a report screen, and a React UI.
- Containerized; runs locally with one command.

**Out of scope** (listed as next steps):
- Auth and multi-tenancy
- Private repos / connecting a repo through a GitHub App
- PR-triggered rescans and diffs between scans
- Auto-fix PRs
- Reachability analysis
- Other ecosystems

## 3. Functional requirements

| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR1 | Submit a scan | Accepts `github.com/{owner}/{repo}` (also `.git` and `/tree/{ref}` forms). Malformed URL → 400 `INVALID_URL`. Missing or private → 404 `REPO_NOT_FOUND`. Too large → 422 `REPO_TOO_LARGE`. All checked before anything is queued. |
| FR2 | Idempotent submit | With an `Idempotency-Key` header: same key and body → original response. Same key, different body → 422. Original still in flight → 409. Keys are kept 24 h. |
| FR3 | Deduplicate per commit | At most 1 active scan per (repo, commit SHA, scanner version). A completed result under 24 h old is reused unless `force=true`. The response is flagged `deduplicated` or `cached`. |
| FR4 | Lifecycle | `queued → running(stage) → completed \| failed \| cancelled`. A partial result is `completed` with coverage gaps listed. Every accepted scan ends in a terminal state. |
| FR5 | Track progress | A snapshot via `GET` plus a live SSE stream that resumes via `Last-Event-ID`. Shows stage, percent done, queue position and a readable timeline. |
| FR6 | Cancel | `POST /scans/:id/cancel` → `cancelled` within 10 s. |
| FR7 | Pluggable scanners | One adapter contract: input is the workspace and repo context; output is normalized findings, with a declared category, timeout and resource class. v1 ships the dependency category. |
| FR8 | Normalize and dedupe | Stable finding IDs (hash of type, advisory, package@version, location). Duplicate advisory IDs for the same issue are merged, e.g. a CVE and its GHSA. |
| FR9 | Exploitability enrichment | Each vulnerability carries: known-exploited flag, exploit-probability score, whether a fix exists, and the fixed version. |
| FR10 | Context classification (optional) | Fuzzy judgments via a classifier with confidence thresholds: file role, real vs placeholder secret, repo type, impact class. Rule-based fallback. Anything suppressed stays visible and can be restored. |
| FR11 | Issues and priority | Each Issue = problem, root cause, fix (command, target version, effort), evidence. A transitive vulnerability is attributed to the direct dependency that pulls it in. Priority comes from a fixed scoring formula. |
| FR12 | Report | Verdict (risk level and headline), top ≤ 5 Issues, ordered action plan, stats, coverage (scanned / not scanned and why), provenance. |
| FR13 | AI explanation (optional) | Schema-validated. Every claim cites an Issue or finding ID. A failure or timeout falls back to template text. Labeled "AI-generated". |
| FR14 | Browse findings | Paginated (≤ 100 per page); filter by severity, category, prod/dev, suppressed. |
| FR15 | Typed errors | `{code, message, retryable}`. A repo with nothing to scan is `completed` with a coverage note, not an error. |
| FR16 | Web UI | React: submit → live progress → report. A `?scan={id}` link survives refresh. |

## 4. Design point and capacity model

Every target below comes from these assumptions. If an assumption changes, recompute. After the first load test, replace the assumptions with measured values.

| # | Assumption | Value | Basis |
|---|---|---|---|
| A1 | Peak demand (design point, DP) | **1,000 scans/h** (≈ 10k/day at a 2.4× peak-to-average ratio) | 60% of the first hard external ceiling (A6). That's the most v1 can serve without changing how it authenticates to GitHub, with 40% headroom. |
| A2 | Repo mix | 70% S / 25% M / 5% L | Size classes in §5.3 |
| A3 | Mean scan service time W | 45 s | Weighted p50 targets from §5.3: 0.70 × 30 s + 0.25 × 60 s + 0.05 × 150 s = 43.5 s, rounded up |
| A4 | Resources per scan | 0.5 vCPU average; hard caps of 1 GB RAM and 2 GB disk | Scans mostly wait on network I/O |
| A5 | Reference worker host | 8 vCPU / 16 GB | Common cloud instance size |
| A6 | GitHub REST calls per scan | 3 (resolve ref, metadata, archive download) | Token quota is [5,000/h; 60/h unauthenticated](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) |
| A7 | AI tokens per scan | ≤ 8k input + 1k output | Top 25 Issues sent as structured context |
| A8 | API calls per scan | 1 POST + ~10 GET + 1 SSE (≤ 30 GET if polling instead) | The UI flow |

| Derived quantity | Formula | Result |
|---|---|---|
| Scan slots per host (c) | min(RAM: (16 − 4 reserved)/1 GB, CPU: 8 × 0.75 / 0.5) | **12** |
| Max slot utilization (ρ) | Erlang-C queueing model (M/M/12, W = 45 s): ρ = 0.6 → p95 queue wait ≈ 4 s; ρ = 0.7 → ≈ 16 s | **ρ ≤ 0.6** |
| Sustained throughput per host | ρ · c / W | ≈ 575/h → **target ≥ 500/h** |
| Burst ceiling per host | c / W | ≈ 960/h (the queue grows above this) |
| Worker hosts needed at DP | ⌈1,000 / 500⌉ | **2, plus 1 spare** |
| Average concurrent scans at DP | Little's law: λ · W = 0.28/s × 45 s | ≈ 12.5 of 24 slots |
| GitHub quota used at DP | 3,000 / 5,000 | 60% of one token; alert at 80% |
| v1 throughput ceiling | 5,000 / 3 | **≈ 1,650 scans/h** (beyond this, use GitHub App per-customer quotas) |
| Without a token | 60 / 3 | 20 scans/h per server IP; demo only |
| API load at DP | 11 calls × 0.28/s (31 calls if polling) | 3 RPS (worst case ≈ 9) |
| DB writes at DP | ~80 writes/scan × 0.28/s | ≈ 22 writes/s |
| AI usage at DP | 9k tokens × 1,000/h | 150k tokens/min (the LLM provider plan must allow this) |
| Storage | 150 KB/scan × 10k/day × 30 days | ≈ 45 GB |

## 5. Non-functional requirements

All targets are measured at design-point load. v1 measures them in a load test; production would measure over a 28-day window.

### 5.1 API latency (measured server-side)

| Endpoint | p50 | p95 | p99 | Why |
|---|---|---|---|---|
| `POST /scans` (new scan) | 300 ms | 800 ms | 2 s | Includes one GitHub round trip (1.5 s timeout). Under 1 s keeps the user's [flow](https://www.nngroup.com/articles/response-times-3-important-limits/). |
| `POST /scans` (idempotent replay) | 20 ms | 50 ms | 100 ms | Database lookup only |
| `GET /scans/:id` | 20 ms | 100 ms | 250 ms | ≤ 0.1 s feels instant |
| `GET /scans/:id/findings` (≤ 100 items, ≤ 256 KB) | 30 ms | 150 ms | 300 ms | Bounded payload |
| SSE connect → first snapshot | 50 ms | 200 ms | 500 ms | |
| SSE event lag (DB commit → client) | 200 ms | 1 s | 2 s | 1 s flow limit |

- **API capacity:** ≥ 100 RPS per instance at these latencies (10× the design-point worst case).
- **SSE capacity:** ≥ 1,000 concurrent streams per instance (≈ 50 KB each), so SSE never drives scaling.

### 5.2 User-perceived

| Metric | Target | Why |
|---|---|---|
| Submit → progress screen showing the first event | p95 ≤ 1 s | 1 s flow limit |
| Longest gap between events while running | ≤ 10 s (long stages emit heartbeats) | 10 s attention limit |
| Frontend responsiveness (75th percentile) | LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 | Google's ["good" Core Web Vitals](https://web.dev/articles/vitals) |

### 5.3 Scan time-to-result (scan created → completed)

A repo's class is the larger of its two dimensions.

| Class | GitHub repo size / lockfile packages | p50 | p95 |
|---|---|---|---|
| S | ≤ 50 MB / ≤ 1k | 30 s | 60 s |
| M | ≤ 250 MB / ≤ 5k | 60 s | 120 s |
| L | ≤ 1 GB / ≤ 20k | 150 s | 300 s (hard deadline, then partial result) |
| Larger than L | Rejected at submit | — | — |
| Cache hit (same commit, < 24 h old) | | — | ≤ 1 s |

Each stage's p95 budget is also its hard timeout. If a stage overruns, it is marked partial and the pipeline continues.

| Stage | S | M | Basis |
|---|---|---|---|
| Queue wait | 10 s | 10 s | ρ ≤ 0.6 |
| Fetch source | 5 s | 20 s | ≥ 25 MB/s download |
| Scanners (run in parallel; slowest counts) | 15 s | 45 s | Timeout per adapter |
| Exploitability enrichment | 2 s | 2 s | Local daily snapshot |
| Classify (optional) | 5 s | 10 s | ≤ 200 calls, 20 at a time, ≤ 0.5 s each |
| Group into Issues and prioritize | 1 s | 2 s | In-process CPU work |
| AI explanation (optional) | 20 s | 25 s | ~1k output tokens; 30 s timeout → template |
| Persistence and event overhead | 2 s | 6 s | |
| **Total** (sum of p95s, conservative) | **60 s** | **120 s** | |

### 5.4 Concurrency and throughput

| Metric | Target |
|---|---|
| Throughput per host | ≥ 500 scans/h with p95 queue wait ≤ 10 s |
| Cluster at design point | 1,000 scans/h (2 hosts + 1 spare) |
| Scaling out | ≥ 90% linear per added host, up to ~1,650/h |
| Duplicate active scans per scan key | 0 (enforced by a unique constraint) |
| Per-client limits (by IP until there is auth) | ≤ 3 active scans, ≤ 10 submits/min → 429 + `Retry-After` |
| Load shedding | Estimated queue wait > 60 s (queued > total slots × 60 s / W, i.e. 32 at DP) → 503 + `Retry-After` |
| Outbound calls | ≤ 20 in flight per GitHub token (GitHub's own cap is 100). Rate limiter per provider that honors `Retry-After`. |

### 5.5 Reliability

| Metric | Target |
|---|---|
| Internal failure rate | ≤ 1% of accepted scans (user errors excluded) |
| Scans failed because of AI or classifier outages | 0; they fall back instead, and the fallback rate is reported |
| Worker crash → scan resumed on another worker | ≤ 60 s (30 s lease, 10 s heartbeat), continuing from the last completed stage |
| Stuck scans (not terminal after deadline + 60 s) | 0 |
| Data loss for accepted scans (RPO) | 0; the scan is committed to the DB before 202 is returned |
| Outbound calls | Timeout on every call, ≤ 3 attempts, exponential backoff with jitter (0.5 s up to 5 s) |
| Production availability target | 99.9%/month (≈ 43 min downtime) with ≥ 2 API instances; v1 runs on a single node and claims none |

**Invariants.** Each must hold 100% of the time and has an automated test:
1. Every accepted scan reaches a terminal state.
2. At most 1 active scan per scan key. Same idempotency key and body → same scan ID.
3. No progress event is lost or duplicated across reconnects.
4. AI output never changes severity, priority, the fix command or the version. Those are rendered from data.
5. No raw secret value is ever stored, returned or logged.
6. Same commit + scanner version + advisory snapshot → identical findings, Issues and ranking.

### 5.6 Hard limits

| Limit | Value | Reason |
|---|---|---|
| Repo size (checked from GitHub metadata before download) | 1 GB | Keeps fetch ≤ 40 s and bounds disk |
| Files scanned / size of any single file | 100k / 5 MB | Bounds scanner time; skips generated and binary files |
| Lockfile | 20 MB / 20k packages | Bounds parsing |
| Scan wall clock | 300 s | Then return a partial result |
| RAM / disk / CPU per scan | 1 GB / 2 GB / 1 vCPU | Slot sizing (A4) |
| Request body | 16 KB | |
| Findings stored per scan | 5,000 (anything beyond is summarized) | Storage and UI |
| Classifier calls per scan | 200 (highest rule-based scores first) | Latency and cost |
| AI context | Top 25 Issues, ≤ 8k tokens | Cost, latency, prompt-injection exposure |
| Result reuse window | 24 h | Advisory data changes daily |

### 5.7 Quality

| Metric | Target |
|---|---|
| AI claims citing existing IDs | 100% (enforced by the output schema) |
| AI fallback rate | ≤ 5% (acceptance gate when choosing the model and prompt) |
| Precision of classifier auto-suppression | ≥ 95% on a labeled sample; below that confidence → "needs review" |
| Coverage disclosure | 100% of reports |
| KPIs reported (not guaranteed) | Findings → Issues compression ratio; % of critical/high findings fixed by the top 5 actions |

### 5.8 Security

- **No execution:** never install, build or run repo code.
- **Sandbox per scan:** no credentials, resource caps from §5.6, outbound traffic restricted to an allowlist.
- **No SSRF:** outbound URLs are built only from the parsed owner/repo, never from the raw user input.
- **Secrets:** redacted at the adapter boundary.
- **LLM input:** repo text reaches the LLM only as length-capped structured fields, after a prompt-injection screen.
- **Credentials:** read from env or a secret store only; never logged or returned.

### 5.9 Cost budgets

These constrain the later choice of tools and models.

| Item | Budget | Reasoning |
|---|---|---|
| AI explanation | ≤ $0.01/scan | 100 free scans per user per month costs ≤ $1 |
| Classifier | ≤ $0.001/scan | |
| Compute | Host cost per hour ÷ 500 | |

### 5.10 Observability

Every target above has a data source:
- **Stage timings:** each stage's start, end and outcome are stored per scan, so p50/p95 by size class come straight from SQL.
- **API:** latency histograms per route; SSE lag = send time − event time.
- **Gauges:**
  - queue depth and age of the oldest queued scan
  - slot utilization
  - GitHub quota remaining (from `X-RateLimit-Remaining`)
  - AI tokens per minute
- **Counters:** terminal status × error code, fallbacks, cache/dedup hits, idempotent replays.
- **Logs and endpoints:** structured JSON logs tagged with the scan ID; `/healthz` and `/metrics` endpoints.

### 5.11 Verification

- **Load test** against stubbed GitHub and advisory APIs, with latencies injected to match §5.3. This isolates our platform's latency, throughput, queue wait and SSE lag from third parties.
- **Chaos tests:**
  - Kill a worker mid-scan → resumed within 60 s, no duplicate findings or events.
  - Restart the API → SSE resumes with 0 lost events.
- **Race tests:**
  - 50 identical submits in parallel → 1 scan.
  - Reuse an idempotency key with a different body → 422.
- **Benchmark** on real public repos per size class; publish measured p50/p95 next to the targets in the README.

## 6. High-level architecture

```text
 React SPA ── POST /scans · GET /scans/:id · /findings · SSE /events · POST /cancel ──┐
                                                                                      ▼
                              ┌───────────────────────────────────────────────┐
                              │ API ×N (stateless): validate · rate-limit ·   │
                              │ idempotency · commit dedup · reads · SSE      │
                              └───────┬───────────────────────────▲───────────┘
             one tx: key + scan + 1st event                       │ new-event notify
                                      ▼                           │
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ PostgreSQL: system of record + work queue (row = job) + event log            │
 │ scans · scan_stages · scan_events · findings · issues · idempotency_keys ·   │
 │ caches (exploit intel, advisories, AI outputs)                               │
 └──────────────────────────────────────▲───────────────────────────────────────┘
                 claim (SKIP LOCKED + lease) · checkpoints · events │
 ┌──────────────────────────────────────┴───────────────────────────────────────┐
 │ Worker ×M (12 slots/host), per scan:                                         │
 │ resolve → fetch (sandbox) → scanners ∥ → normalize → enrich → classify?      │
 │ → group into Issues + prioritize → explain? → publish                        │
 └───────┬────────────────┬─────────────────────┬──────────────────┬────────────┘
         ▼                ▼                     ▼                  ▼
      GitHub      advisory + exploit       classifier API       LLM API
                  intel sources            (optional)           (optional)
```

| Component | Responsibility | How it scales |
|---|---|---|
| React SPA | Submit, live progress, report | Static files / CDN |
| API service | Validation, rate limits, idempotency, commit-level dedup, read endpoints, SSE | Add instances (stateless) |
| PostgreSQL | Durable state; the queue (one row per job); event log; caches | Bigger instance; read replicas later |
| Scan workers | Claim a scan, run the pipeline, save progress after each stage, send heartbeats | Hosts × slots |
| Scanner adapters | Detection per category behind one contract | Add adapters; heavy ones move to a separate pool later |
| Sandbox | Throwaway per-scan workspace with resource caps and an outbound allowlist | One per slot |
| Intel cache | Daily exploitability snapshot; advisory cache by package@version | Refresh job |

**Scan states:**
```text
queued ──claim──► running(stage…) ──► completed   (including partial + coverage gaps)
   │                 │   └──────────► failed      (typed error, after ≤ 3 attempts)
   └──cancel─────────┴──────────────► cancelled
lease expires → claimable again (attempt + 1), resumes from the last saved stage
```

**Key flows:**
1. **Submit:**
   1. Validate the URL.
   2. Look up the idempotency key; replay the original response on a hit.
   3. Ask GitHub in parallel for the commit SHA and repo metadata (exists? size?).
   4. In one transaction, insert the key, the scan, and the first event. If an active scan already exists for that key, return it instead.
   5. Return `202` with a `Location` header.
2. **Execute:**
   1. A worker claims the oldest claimable scan using `FOR UPDATE SKIP LOCKED` (30 s lease, 10 s heartbeat).
   2. For each stage: skip it if already saved; otherwise run it with its timeout, then save the output and emit an event.
   3. Check the cancel flag between stages and on every heartbeat.
   4. Finish with a conditional update tied to the claim's `attempt` number, so a stale worker can't overwrite.
3. **Observe:** SSE first sends events with `seq > Last-Event-ID`, then streams new ones, and closes when the scan reaches a terminal state. `GET` returns the same state for refreshes or polling.

| Table | Key | Purpose |
|---|---|---|
| `scans` | `id`; `scan_key` unique among active scans | Lifecycle, lease (`attempt`, `lease_until`, `worker`), provenance, report summary |
| `scan_stages` | (`scan_id`, `stage`) | Saved stage output and timings (also the latency data source) |
| `scan_events` | (`scan_id`, `seq`) | Progress timeline; lets SSE resume |
| `findings` | (`scan_id`, `finding_id`) | Normalized evidence, enrichment, classification |
| `issues` | (`scan_id`, `issue_id`) | Problem, root cause, fix, finding IDs, priority |
| `idempotency_keys` | `key` | Request hash → scan ID and response; 24 h TTL |

| Endpoint | Returns |
|---|---|
| `POST /api/scans` `{repoUrl, ref?, force?}` + `Idempotency-Key` | 202 new · 200 dedup/cached · 400/404/409/422/429/503 |
| `GET /api/scans/:id` | Status, stage, progress, queue position, report summary |
| `GET /api/scans/:id/findings?cursor&filters` | Paginated findings |
| `GET /api/scans/:id/events` | SSE stream (resumable) |
| `POST /api/scans/:id/cancel` | 202 |
| `GET /api/healthz` · `/api/metrics` | Ops |

**Scaling path:**

| Load | First bottleneck | Response |
|---|---|---|
| > 20 scans/h | Unauthenticated GitHub quota | Server token (required config) |
| > ~1,650 scans/h | Quota of a single token | GitHub App tokens: 5k–12.5k/h per customer install |
| AI demand above the provider's tokens/min limit | LLM quota | Rate limiter → template fallback; throughput unaffected |
| ~10× design point | DB writes / queue contention | Partition the event table, move to a dedicated queue broker, add read replicas |
| Heavy analyzers | CPU and RAM | Separate heavy queue and worker pool |

## 7. Decisions and trade-offs

| Decision | Choice | Alternative rejected | Why |
|---|---|---|---|
| Execution | Async job + progress stream | Synchronous request | Scans take 30–300 s |
| Queue | Postgres row as the job (`SKIP LOCKED` + lease) | Redis queue, workflow engine | One dependency; enqueue shares a transaction with the idempotency key, so the two can't get out of sync; the design point needs < 1 claim/s |
| Progress transport | SSE + snapshot GET | WebSocket, polling only | Data flows one way; reconnect and resume are built in |
| Resolving the ref to a SHA | Synchronously in POST | In the worker | Instant "not found / too large" errors; exact dedup per commit; costs ≤ 0.8 s at p95 |
| Who decides risk | Rules + classifier; LLM only explains | LLM decides | Reproducible, auditable, no invented risks |
| Reusing results | Per commit, 24 h | Always rescan | Cost and latency; advisory data refreshes daily |
| Source access | Read-only fetch into a sandbox | Clone, install and build | Never runs untrusted code |
| AI stage | Inline with a 30 s timeout | Publish the report first, add AI later | Simpler. If the AI stage ends up dominating time-to-result, add a `report_ready` milestone. |

**Deferred tool decisions.** Each candidate must meet these criteria:

| Choice | Must satisfy |
|---|---|
| Scanner adapters | License allows commercial SaaS use; never executes repo code; machine-readable output; ≤ 45 s p95 and ≤ 1 GB on M-class repos |
| Advisory and exploit-intel sources | Terms allow commercial use; refreshed at least daily; support batch lookups |
| Classifier | Typed outputs with calibrated confidence; ≤ 0.5 s p95; ≤ $0.001/scan |
| LLM | JSON-schema output; ≤ 20 s p95 for ~1k output tokens; ≥ 150k tokens/min; ≤ $0.01/scan |

---

The capacity numbers depend on assumptions A1–A8, especially the 45 s mean scan time and 0.5 vCPU / 1 GB per scan. The queueing model also assumes more predictable scan times than real repos will have, so tail wait times are likely understated. Replace both with measured values after the first load test.

The 3-hour build will cover a slice of this: a single host and one scanner category. When you present it, show these as design targets with the measured results next to them.
