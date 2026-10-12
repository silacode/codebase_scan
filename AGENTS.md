# Repository guidance

## Runtime and development

- Backend and frontend share the root npm package and lockfile; run commands from the root.
  Use Node >=22.18 and `npm ci`. Backend TypeScript runs directly in Node: use `.ts` import
  extensions and erasable syntax; there is no backend compilation step.
- Start PostgreSQL with `docker compose up -d db`, then run `npm run dev` and `npm run dev:web`
  in separate terminals. Vite uses port 5174 and proxies `/api` to the backend on 8080.
- `src/config.ts` reads `process.env` at import time. The Node npm scripts do not load `.env`;
  export variables or use `node --env-file=.env --watch src/index.ts` to load it explicitly.
- `npm run build` produces only `web/dist`, which Fastify serves. Edit frontend source, not dist.

## Checks and test prerequisites

- Available checks: `npm run format:check`, `npm run typecheck` (backend and web), `npm test`
  (unit only), `npm run build`, `npm run test:integration`, and `npm run test:web`.
- Focus a file and optionally a test name:

  ```sh
  npm test -- test/unit/report.test.ts -t "test name"
  npm run test:integration -- test/integration/api.test.ts -t "test name"
  npm run test:web -- test/e2e/scan.spec.ts -g "test name"
  ```

- Build the UI before integration tests: static/SPA contracts serve real `web/dist` assets.
  Start the Compose database first. `test/helpers/database.ts` requires the input `DATABASE_URL`
  to target `/scan` on `localhost` or `127.0.0.1`, port 5433 (the default); it creates and resets
  `scan_test`. Keep integration suites serial, including separate test invocations.
- Integration helpers set the test database URL before dynamically importing backend modules;
  reuse them so import-time configuration points at the test database. Upstream APIs are stubbed.
- Playwright requires `npx playwright install chromium` once per machine. It owns a Vite server
  on port 5186, refuses server reuse, and stubs the scan API; it needs no running backend.
- Use `app.inject()` for ordinary HTTP contracts and real sockets for SSE/lifecycle behavior.
  Browser contracts belong in `test/e2e/`; Vitest runs Node unit and integration projects.

## Change boundaries

- `src/index.ts` owns migrations, queue startup, role selection, and shutdown; `src/app.ts` is the
  Fastify factory. HTTP schemas in `src/api/scan-request-schemas.ts` drive validation and request
  types; browser-safe shared validation lives in `src/contracts/`.
- `src/scans/scan-service.ts` owns submit/cancel transactions; `scan-queries.ts` owns reads.
  Keep scan and pg-boss changes atomic via `fromDrizzle`. Worker persistence goes through
  `scan-attempt-store.ts`: preserve application/queue ownership guards and checkpoint recovery
  when changing `src/scans/pipeline/scan-pipeline.ts`.
- Keep Drizzle mappings in `src/db/schema.ts` consistent with bootstrap DDL in `schema.sql` and
  idempotent upgrades in `migrate.ts`; startup runs these migrations. pg-boss owns its own schema.
- Add scanners through `ScannerAdapter` in `src/scanners/scanner-types.ts` and register them in
  `scanner-registry.ts`. Scanned repositories must never be installed, built, or executed.
- Bump `SCANNER_VERSION` in `src/config.ts` when finding shapes change; it keys result reuse.
- `web/src/features/scans/types/scan-contracts.ts` derives wire types from backend producers and
  maps Dates to strings. Change server shapes first, retain legacy-report overlays, and fix
  typecheck errors rather than redeclaring/widening client shapes. Backend references from the
  browser must be type-only unless the module is browser-safe shared validation.
- For frontend work, follow [web/README.md](web/README.md) and
  [web/DESIGN_SYSTEM.md](web/DESIGN_SYSTEM.md): shared UI/hooks cannot import scan features;
  reuse existing primitives and the semantic tokens in `web/src/styles/design-tokens.css`.
- OpenAI may replace explanation text only, never findings, scores, versions, or fix commands.
  Preserve template/rules fallbacks for missing optional providers or failed requests.
- Name numeric policies by meaning and unit, keep them with their owning module, and share only
  when the policy is the same, not merely the value. Use Node HTTP status constants on the backend.

## Test contracts

- State the observable contract before adding or changing a test. Add coverage only
  if user-facing or stable consumer behavior could regress, is worth constraining,
  and the test would survive an internal rewrite.
- Do not add tests automatically or merely confirm what a patch added, removed,
  or changed. Protect meaningful observable behavior, not private structure.
- Do not assert CSS classes, dimensions, exact DOM shape, UI primitive internals,
  or implementation call order. Visual-only changes get visual validation,
  not new automated tests.

## Validation

- Complete the entire plan, then review each bullet against its source and run all required
  checks: formatting, typechecking, relevant tests, and builds. If issues are found, complete
  all fixes before rerunning validation—never validate after individual edits.
