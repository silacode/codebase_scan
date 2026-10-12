# Contributing

## Tests

```sh
npm run format        # apply Prettier to hand-written code
npm run format:check  # verify formatting without changes
npm run typecheck
npm test
npm run build         # integration static/SPA tests serve real web/dist assets
# Requires docker compose up -d db; creates an isolated scan_test database
npm run test:integration
npx playwright install chromium # once per machine
npm run test:web          # owned Vite server on port 5186; stubbed API
```

- On a fresh checkout, build the UI before running integration tests so their static/SPA checks can serve `web/dist`.
- Vitest runs Node unit and serial integration projects; Playwright remains the browser test runner.
- The root TypeScript check remains strict for application and test files but uses `skipLibCheck` because upstream dependency declarations currently fail to compile; dependency declaration internals are not checked.
- Unit tests stub external APIs and exercise URL safety, npm lockfiles and fixes, scoring, AI/Jev fallback, and tar extraction.
- Integration tests use isolated `scan_test`, real pg-boss workers, and stubbed GitHub/OSV/KEV/EPSS/registry APIs for races, recovery, checkpoints, pipeline, SSE, cancellation, and limits. No live GitHub scan is needed.

## Conventions

- Name numeric policies by meaning and unit, keep them with their owning module, and share them only when consumers mean the same policy — not merely because their values match. For example, `SCAN_DEADLINE_MS` in `src/config.ts` governs the overall scan deadline.
- On the backend, use Node's HTTP status constants instead of numeric response/error status literals.
- Taxonomy lives in data modules, not logic: CWE mappings in `src/analysis/cwe-impact-map.ts`, buckets and criteria in `src/analysis/taxonomy.ts`. Every bucket must trace to a standard section, ecosystem self-description, or calibrated measurement — see the module headers.

## Backend modules

```text
src/index.ts, app.ts, config.ts, errors.ts, logger.ts
src/contracts/repo-url.ts
src/api/{scan-routes,scan-event-routes,system-routes,scan-request-schemas}.ts
src/scans/{scan-service,scan-queries,scan-worker,scan-attempt-store}.ts
src/scans/pipeline/{scan-pipeline,pipeline-stages}.ts
src/reports/{report-builder,issue-builder,issue-scoring,remediation-planner,issue-types}.ts
src/analysis/{finding-enrichment,context-classifier,issue-explainer,cwe-impact-map,taxonomy}.ts
src/integrations/{http-client,github-repository}.ts
src/scanners/{scanner-registry,scanner-types,npm-dependency-scanner}.ts
src/queue/scan-queue.ts
src/db/{database-client,scan-event-store,cache-store,schema,migrate}.ts, src/db/schema.sql
test/unit/*.test.ts
test/integration/{api,pipeline,queue,migration}.test.ts
test/helpers/{database,fixtures,api,crash-worker,migrate}.ts
test/e2e/*.spec.ts
```

- `src/app.ts` creates the Fastify instance, registers the plugins in `src/api/`, and serves the existing UI; `src/index.ts` owns process startup and shutdown. Add endpoints to `scan-routes.ts`, `scan-event-routes.ts`, or `system-routes.ts` as appropriate.
- `src/api/scan-request-schemas.ts` owns shared Zod HTTP request schemas. Snapshot, findings and cancellation reuse `scanId` in their Fastify route schemas. Route plugins use `FastifyPluginAsyncZod`, so the same schema drives validation and TypeScript inference of `req.params` without a parallel HTTP interface. `src/contracts/` holds schemas shared with the web UI (repository URL). Keep transport validation separate from domain checks and database rows.
- `src/scans/scan-service.ts` owns submit/cancel transactions; `scan-queries.ts` owns snapshots, evidence and metrics. `scan-worker.ts` claims queue deliveries; `scan-pipeline.ts` executes attempts using `pipeline-stages.ts` and the fenced `scan-attempt-store.ts`.
- `src/reports/issue-builder.ts` groups and sorts findings; `issue-scoring.ts` holds ranking factors, `remediation-planner.ts` chooses safe fixes and registry candidates, and `report-builder.ts` assembles the final report. Provider fallbacks remain in `src/analysis/`; HTTP and GitHub clients live in `src/integrations/`.
- `src/db/database-client.ts` owns the pool and Drizzle transaction type. `schema.ts` maps application tables; `migrate.ts` installs `schema.sql`; `scan-event-store.ts` owns durable event sequencing and reconnecting LISTEN; `cache-store.ts` is the shared scanner cache. `src/queue/scan-queue.ts` owns pg-boss and the finalizer. Add normal database reads to `scan-queries.ts`, keeping transaction fences with their writer in `scan-service.ts` or `scan-attempt-store.ts`.
- Put observable HTTP contract coverage in `test/integration/api.test.ts`, pipeline/report cases in `pipeline.test.ts`, delivery/recovery cases in `queue.test.ts`, and schema preservation in `migration.test.ts`. All use `test/helpers/database.ts`; API suites also use the shared archive/upstream fixtures and Fastify app helper. Use `app.inject()` for ordinary request/reply cases and a real socket for SSE or lifecycle cases. Browser behavior belongs in `test/e2e/`, not a second Vitest browser suite.

## Frontend types

`web/src/features/scans/types/scan-contracts.ts` derives its response types (`Finding`, `Issue`, `Report`, `Scan`) from `src/scanners/scanner-types.ts`, `src/reports/{issue-types,report-builder}.ts` and `src/scans/scan-queries.ts`; it never redeclares them. `Json<T>` maps Date columns to ISO strings, and the legacy overlay keeps fields optional where stored older reports require fallbacks. Change the server shape first, then fix whatever `npm run typecheck` points at in the web app or fixtures; do not widen or re-declare a wire shape client-side. See [web contributor guide](../web/README.md) for screens, hooks, transport and shared UI.
