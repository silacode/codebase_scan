# How scanning and ranking work

## Pipeline

- The API validates a public GitHub URL, resolves its branch/tag to a commit SHA, checks repository size, and queues a row in PostgreSQL.
- A worker fetches that commit tarball to a disposable workspace; it **never installs, builds or executes** code.
- The registered npm adapter finds `package-lock.json` v1/v2/v3 files, reads packages and dependency paths, and queries OSV in batches.
- Enrichment looks up CISA's Known Exploited Vulnerabilities catalog and FIRST EPSS.
- Rules classify repository type and vulnerability impact; optional Jev can refine uncertain calls.
- Issues group findings by direct dependency, choosing a production direct dependency ahead of a development one when both introduce the same package (then the shorter path, then name).
- Fix candidates are chosen, priority is computed, optional OpenAI explains, and the report and evidence are published atomically.
- Progress stages are `fetch → scan_dependencies → enrich → classify → prioritize → explain → publish`.
- Optional upstream failures leave a warning and template/rules fallback.

To add an adapter, implement `ScannerAdapter` in `src/scanners/scanner-types.ts` and register it in `src/scanners/scanner-registry.ts`. The context grants only the downloaded workspace, repo metadata, cancellation signal, progress callback, and cache. An adapter returns normalized findings, stats, and explicit coverage; the pipeline does not need to change.

## Scoring

A finding scores `severity × exploit × exposure × repo exposure`:

- Severity weights: critical 10, high 7, medium 4, low 1.
- Exploit factor: KEV 2; otherwise EPSS ≥ 0.1 is 1.5; otherwise 1.
- Exposure: production 1, dev 0.3.
- Repo exposure: 1.2 for a web service with code execution, denial of service, XSS, SSRF, path traversal, injection, or auth bypass; otherwise 1.

Issue priority is **highest finding score + min(0.5 × highest finding score, 0.1 × the sum of the others)**. Order is priority descending, then fixable, then lower effort, then ID. This formula never uses AI output.

## Fix ladder

- A vulnerable direct dependency gets an `npm install name@fixed` target only when it is a stable version newer than the installed one (prereleases are allowed only when already installed).
- When the parent's declared range already permits the fix, refresh the lockfile with `npm update`.
- Otherwise registry metadata selects the lowest newer release, preferring the installed major, that fixes the direct dependency's own findings and either permits fixes for its immediate vulnerable children or removes those children from its declared dependencies, optional dependencies, and peer dependencies.
- Deeper paths require a verify-after-upgrade note; if nothing can be checked, `latest` is used only when stable and newer.
- When no release qualifies, an `override` fix supplies a `package.json` overrides snippet for fixable transitive packages, or advises replacing the direct dependency if there are no transitive packages to override.
- Only an Issue with no fixed versions at all is marked `no_fix`.
- Mixed Issues keep the command computed from fixable findings, name the remaining unfixable packages in a note, and list both counts.
- The action plan includes Issues with commands and counts only their fixable findings as resolved; when the registry is unavailable, it gives a manual upgrade action without a command.
- An Issue's evidence lists its finding IDs and dependency paths.
- Each Issue still belongs to one lockfile and direct dependency; the report labels its project folder and any declaring npm workspaces.
- Identical fixes across projects merge into one action step with per-project findings, notes, and commands.
- Commands are copyable from the repository root: `--prefix` selects a nested project and `-w` selects a declaring workspace for installs; lockfile refreshes use `--prefix` without `-w`.
- Folder and package arguments are shell-quoted, and invalid npm package names never produce a command.
- Override snippets name the project `package.json` to edit.
- Scanner version `1.1.0` changes the scan cache key so earlier reports remain available without being reused.
