import os from 'node:os';
import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import { config, MAX_LOCKFILE_BYTES, SCAN_DEADLINE_MS } from '../../config.ts';
import { db, tx } from '../../db/database-client.ts';
import { emitEvent } from '../../db/scan-event-store.ts';
import { cacheGet, cacheSet } from '../../db/cache-store.ts';
import { scans } from '../../db/schema.ts';
import { ScanError } from '../../errors.ts';
import { log } from '../../logger.ts';
import { downloadSnapshot } from '../../integrations/github-repository.ts';
import { adapters } from '../../scanners/scanner-registry.ts';
import type { ScanContext, AdapterResult } from '../../scanners/scanner-types.ts';
import { enrich } from '../../analysis/finding-enrichment.ts';
import { classify } from '../../analysis/context-classifier.ts';
import { explain } from '../../analysis/issue-explainer.ts';
import { buildIssues } from '../../reports/issue-builder.ts';
import { buildReport, topIssues } from '../../reports/report-builder.ts';
import type { Issue } from '../../reports/issue-types.ts';
import { completedStages, finish, owns, saveStage } from '../scan-attempt-store.ts';
import type { Job } from '../scan-attempt-store.ts';
import { stages } from './pipeline-stages.ts';

// Catch takeovers during long stages.
const CANCELLATION_POLL_INTERVAL_MS = 1_000;
// Best-effort assembly after the deadline.
const PARTIAL_REPORT_BUDGET_MS = 25_000;
type Enrichment = Awaited<ReturnType<typeof enrich>>;
type Classification = Awaited<ReturnType<typeof classify>>;
type Prioritized = { issues: Issue[]; report: ReturnType<typeof buildReport> };

/**
 * Everything the stage loop and failure handler read or mutate during one runJob attempt.
 * Passed explicitly (instead of shared via closures) so each helper states what it touches;
 * `lost`/`cancelled`/`pollError` are boxed here because several helpers set them.
 */
type RunState = {
  job: Job;
  folder: string;
  controller: AbortController;
  shutdown?: AbortSignal;
  ctx: ScanContext;
  completedStages: Map<string, unknown>;
  outputs: {
    scanned: AdapterResult;
    enrichment: Enrichment | undefined;
    classification: Classification | undefined;
    prioritized: Prioritized | undefined;
  };
  stageWarnings: string[];
  stageGaps: { what: string; why: string }[];
  lost: boolean;
  cancelled: boolean;
  pollError: unknown;
};

/** Abort the run when the DB row shows another attempt or a cancellation took over. */
async function checkCancel(state: RunState) {
  if (state.pollError) throw state.pollError;
  const checked = await tx(async (c) => {
    const [row] = await c
      .select({ cancelRequested: scans.cancelRequested })
      .from(scans)
      .where(
        and(
          eq(scans.id, state.job.id),
          eq(scans.attempt, state.job.attempt),
          eq(scans.status, 'running'),
        ),
      )
      .for('update');
    return {
      active: Boolean(row) && (await owns(c, state.job)),
      cancelled: row?.cancelRequested,
    };
  });
  if (!checked.active) {
    state.lost = true;
    state.controller.abort();
  } else if (checked.cancelled) {
    state.cancelled = true;
    state.controller.abort();
  }
}

/** Build issues + a report from whatever the latest completed stage produced. */
async function makeReport(state: RunState, signal: AbortSignal = state.ctx.signal) {
  const { scanned, enrichment, classification } = state.outputs;
  const findings = classification?.findings ?? enrichment?.findings ?? scanned.findings;
  const issues = await buildIssues(findings, classification?.repoType ?? 'library', {
    ...state.ctx,
    signal,
  });
  const coverage = {
    scanned: scanned.coverage.scanned,
    notScanned: [
      ...scanned.coverage.notScanned,
      ...(enrichment?.notScanned ?? []),
      ...state.stageGaps,
    ],
  };
  const report = buildReport({
    findings,
    issues,
    repoType: classification?.repoType ?? 'library',
    coverage,
    stats: scanned.stats,
    repo: { ...state.ctx.repo, ref: state.job.ref },
    advisoryDataAt: enrichment?.advisoryDataAt ?? new Date().toISOString(),
    kevCatalogAt: enrichment?.kevCatalogAt,
    warnings: [
      ...(enrichment?.warnings ?? []),
      ...(classification?.warnings ?? []),
      ...state.stageWarnings,
    ],
    ai: { used: false },
    classifier: { source: classification?.source ?? 'rules' },
  });
  return { issues, report };
}

/**
 * Run one pipeline stage and persist its output, resuming skips aside. Required-stage
 * failures throw (after saving a 'failed' row); optional-stage failures only downgrade the
 * stage to 'partial' and the scan continues without that stage's data.
 */
async function runStage(state: RunState, stage: (typeof stages)[number]) {
  const { job, controller, completedStages, outputs } = state;

  // Already done by an earlier attempt of this scan — resume, don't redo. Except fetch:
  // its workspace folder is gone (see the finally in runJob), so it always re-runs unless
  // the whole dependency scan is already persisted, in which case nothing needs the files.
  if (completedStages.has(stage.name) && stage.name !== 'fetch') return;
  if (stage.name === 'fetch' && completedStages.has('scan_dependencies')) return;

  const startedAt = new Date(),
    start = Date.now();
  const stageSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(stage.timeoutMs)]);
  let persisting = false;
  try {
    let output: unknown;
    if (stage.name === 'fetch')
      output = await downloadSnapshot(
        job.owner,
        job.repo,
        job.commitSha,
        state.folder,
        stageSignal,
      );
    if (stage.name === 'scan_dependencies') {
      const result = await Promise.all(
        adapters.map((adapter) =>
          adapter.run({
            ...state.ctx,
            signal: AbortSignal.any([stageSignal, AbortSignal.timeout(adapter.timeoutMs)]),
          }),
        ),
      );
      const skipped =
        (completedStages.get('fetch') as Awaited<ReturnType<typeof downloadSnapshot>> | undefined)
          ?.skipped.lockfiles ?? [];
      outputs.scanned = {
        findings: result.flatMap((r) => r.findings),
        coverage: {
          scanned: result.flatMap((r) => r.coverage.scanned),
          notScanned: [
            ...result.flatMap((r) => r.coverage.notScanned),
            ...skipped.map((what) => ({
              what,
              why: `lockfile exceeds ${MAX_LOCKFILE_BYTES / 1024 ** 2} MB`,
            })),
          ],
        },
        stats: Object.assign({}, ...result.map((r) => r.stats)),
      };
      output = outputs.scanned;
    }
    if (stage.name === 'enrich') {
      outputs.enrichment = await enrich(outputs.scanned.findings, {
        ...state.ctx,
        signal: stageSignal,
      });
      output = outputs.enrichment;
    }
    if (stage.name === 'classify') {
      outputs.classification = await classify(
        outputs.enrichment?.findings ?? outputs.scanned.findings,
        { ...state.ctx, signal: stageSignal },
      );
      output = outputs.classification;
    }
    if (stage.name === 'prioritize') {
      outputs.prioritized = await makeReport(state, stageSignal);
      output = outputs.prioritized;
    }
    if (stage.name === 'explain' && outputs.prioritized) {
      const explanation = await explain(
        outputs.prioritized.issues,
        outputs.prioritized.report.verdict.summary,
        { ...state.ctx, signal: stageSignal },
      );
      outputs.prioritized.report.verdict.summary = explanation.summary;
      outputs.prioritized.report.ai = explanation.ai;
      outputs.prioritized.report.topIssues = topIssues(outputs.prioritized.issues);
      output = outputs.prioritized;
    }

    // Downgrade the outcome when the stage ran but its upstream data came from fallbacks.
    const partial =
      (stage.name === 'enrich' && !!outputs.enrichment?.warnings.length) ||
      (stage.name === 'classify' && !!outputs.classification?.warnings.length) ||
      (stage.name === 'explain' &&
        !!config.openaiKey &&
        !!outputs.prioritized?.report.ai.fallbackReason);
    persisting = true;
    if (
      !(stage.name === 'fetch' && completedStages.has('fetch')) &&
      !(await saveStage(
        job,
        stage.name,
        output,
        partial ? 'partial' : 'ok',
        startedAt,
        partial ? 'upstream fallback' : undefined,
      ))
    ) {
      state.lost = true;
      throw Error('Scan ownership lost');
    }
    persisting = false;
    completedStages.set(stage.name, output);
    log('info', 'stage completed', {
      scanId: job.id,
      stage: stage.name,
      durationMs: Date.now() - start,
    });
  } catch (err) {
    // Not a stage failure: shutdown, lost lease, a failed cancel-poll, or an abort while
    // persisting — all belong to the outer handler, so rethrow untouched.
    if (controller.signal.aborted || state.lost || state.pollError || persisting) throw err;
    const message = err instanceof Error ? err.message : 'stage failed';
    if (!stage.optional) {
      if (!(await saveStage(job, stage.name, {}, 'failed', startedAt, message)))
        throw Error('Scan ownership lost');
      if (stageSignal.aborted) throw new ScanError('TIMEOUT', `${stage.name} timed out`, true);
      if (err instanceof ScanError) throw err;
      throw new ScanError(stage.name === 'fetch' ? 'FETCH_FAILED' : 'SCAN_FAILED', message, true);
    }
    if (!(await saveStage(job, stage.name, {}, 'partial', startedAt, message)))
      throw Error('Scan ownership lost');
    await state.ctx.progress(`Warning: ${stage.name} unavailable: ${message}`);
    state.stageWarnings.push(`${stage.name}: ${message}`);
    if (stage.name === 'enrich')
      state.stageGaps.push({ what: 'CISA KEV / FIRST EPSS', why: message });
    if (outputs.prioritized) {
      outputs.prioritized.report.warnings.push(`${stage.name}: ${message}`);
      outputs.prioritized.report.coverage.notScanned.push(...state.stageGaps);
    }
  }
}

/**
 * Map a thrown error from the stage loop to a terminal outcome for this attempt:
 *  - rethrow when the poll failed, the lease was lost, or we are shutting down (pg-boss
 *    redelivers; the next attempt resumes from persisted stages),
 *  - return quietly when the scan was cancelled (cancel() already wrote the terminal row),
 *  - complete early with a partial report when the deadline hit after dependencies were
 *    scanned (so users still get a report); failing that, fail as TIMEOUT,
 *  - requeue (status back to 'queued') when the error is retryable and not a timeout,
 *  - otherwise persist `failed`.
 */
async function handleFailure(state: RunState, err: unknown): Promise<void> {
  const { job, controller, completedStages, outputs } = state;
  if (state.pollError) throw state.pollError;
  if (state.lost || state.shutdown?.aborted) throw err;
  if (state.cancelled) return;
  if (
    controller.signal.aborted &&
    controller.signal.reason instanceof ScanError &&
    controller.signal.reason.code === 'TIMEOUT' &&
    completedStages.has('scan_dependencies')
  ) {
    try {
      outputs.prioritized ??= await makeReport(
        state,
        AbortSignal.timeout(PARTIAL_REPORT_BUDGET_MS),
      );
      outputs.prioritized.report.warnings.push('Scan deadline reached; later stages incomplete');
      outputs.prioritized.report.coverage.notScanned.push({
        what: 'later stages',
        why: 'scan deadline exceeded',
      });
      if (
        !(await finish(
          job,
          'completed',
          outputs.prioritized.report,
          outputs.classification?.findings ??
            outputs.enrichment?.findings ??
            outputs.scanned.findings,
          outputs.prioritized.issues,
        ))
      )
        throw new Error('Scan ownership lost');
    } catch (error) {
      if (
        error instanceof ScanError ||
        (error instanceof Error && error.message === 'Scan ownership lost')
      )
        throw error;
      if (
        !(await finish(job, 'failed', undefined, [], [], {
          code: 'TIMEOUT',
          message: 'Scan deadline exceeded',
          retryable: false,
        }))
      )
        throw new Error('Scan ownership lost');
    }
  } else {
    const code = controller.signal.aborted ? 'TIMEOUT' : 'SCAN_FAILED';
    const message = err instanceof Error ? err.message : 'Scan failed';
    const e = err instanceof ScanError ? err : new ScanError(code, message, true);
    // Retryable and not a timeout: put the scan back to 'queued' and let pg-boss redeliver.
    if (e.retryable && controller.signal.reason?.code !== 'TIMEOUT') {
      await tx(async (c) => {
        const [row] = await c
          .select({ id: scans.id })
          .from(scans)
          .where(
            and(eq(scans.id, job.id), eq(scans.attempt, job.attempt), eq(scans.status, 'running')),
          )
          .for('update');
        if (!row || !(await owns(c, job))) return;
        await emitEvent(c, job.id, job.attempt, 'queued', 'warn', `Retrying: ${e.message}`);
        await c.update(scans).set({ status: 'queued' }).where(eq(scans.id, job.id));
      });
      throw err;
    }
    if (
      !(await finish(job, 'failed', undefined, [], [], {
        code: e.code,
        message: e.message,
        retryable: e.retryable,
      }))
    )
      throw new Error('Scan ownership lost');
  }
}

/**
 * Execute one scan attempt end to end: fetch, scan, enrich, classify, prioritize, explain —
 * persisting each stage so a redelivered attempt resumes instead of redoing work. Aborts
 * (a) when the per-second DB poll sees this attempt is no longer the running one, (b) on the
 * shutdown signal, or (c) at the overall scan deadline; handleFailure then picks the
 * terminal outcome. Never throws for cancellations; rethrows for redelivery-worthy ends.
 */
export async function runJob(job: Job, shutdown?: AbortSignal) {
  const controller = new AbortController();
  const folder = path.join(os.tmpdir(), `scan-${job.id}-${job.attempt}`);
  const resume = await completedStages(job);
  const state: RunState = {
    job,
    folder,
    controller,
    shutdown,
    ctx: {
      workspaceDir: folder,
      repo: { owner: job.owner, repo: job.repo, commitSha: job.commitSha },
      signal: controller.signal,
      progress: async (message) => {
        await tx(async (c) => {
          const [row] = await c
            .select({ stage: scans.stage })
            .from(scans)
            .where(
              and(
                eq(scans.id, job.id),
                eq(scans.attempt, job.attempt),
                eq(scans.status, 'running'),
              ),
            )
            .for('update');
          if (!row || !(await owns(c, job))) throw Error('Scan ownership lost');
          await emitEvent(c, job.id, job.attempt, row.stage, 'info', message);
        });
      },
      cache: { get: cacheGet, set: cacheSet },
    },
    completedStages: resume,
    outputs: {
      scanned: (resume.get('scan_dependencies') as AdapterResult | undefined) ?? {
        findings: [],
        coverage: { scanned: [], notScanned: [] },
        stats: { packages: 0, lockfiles: 0 },
      },
      enrichment: resume.get('enrich') as Enrichment | undefined,
      classification: resume.get('classify') as Classification | undefined,
      prioritized: (resume.get('explain') ?? resume.get('prioritize')) as Prioritized | undefined,
    },
    stageWarnings: [],
    stageGaps: [],
    lost: false,
    cancelled: false,
    pollError: undefined,
  };

  // Shutdown races the pipeline: mark state lost, then the abort propagates into every
  // in-flight stage fetch through the shared controller.
  const onAbort = () => {
    state.lost = true;
    controller.abort(shutdown?.reason);
  };
  shutdown?.addEventListener('abort', onAbort, { once: true });
  if (shutdown?.aborted) onAbort();

  // Independent cancel/loss detector: the lease checks above only run inside writes, so this
  // poll covers the gaps and aborts promptly even when a stage is just waiting on network.
  let poll: Promise<void> | undefined;
  const cancelPoll = setInterval(() => {
    if (poll) return;
    poll = db
      .select({ status: scans.status, attempt: scans.attempt })
      .from(scans)
      .where(eq(scans.id, job.id))
      .then((rows) => {
        if (rows[0]?.status !== 'running' || rows[0]?.attempt !== job.attempt) {
          state.lost = true;
          controller.abort();
        }
      })
      .catch((error: unknown) => {
        state.pollError = error;
        controller.abort(error);
      })
      .finally(() => {
        poll = undefined;
      });
  }, CANCELLATION_POLL_INTERVAL_MS);
  const deadline = setTimeout(
    () => controller.abort(new ScanError('TIMEOUT', 'Scan deadline exceeded', true)),
    Math.max(1, SCAN_DEADLINE_MS - (Date.now() - new Date(job.startedAt).getTime())),
  );

  try {
    // Only needed for stages that touch the files; a resumed scan with dependencies already
    // persisted skips fetch entirely and needs no workspace.
    if (!state.completedStages.has('scan_dependencies')) await mkdir(folder, { recursive: true });
    for (const stage of stages) {
      await checkCancel(state);
      if (controller.signal.aborted) throw controller.signal.reason;
      await runStage(state, stage);
    }
    if (
      !state.lost &&
      !state.cancelled &&
      state.outputs.prioritized &&
      !(await finish(
        state.job,
        'completed',
        state.outputs.prioritized.report,
        state.outputs.classification?.findings ??
          state.outputs.enrichment?.findings ??
          state.outputs.scanned.findings,
        state.outputs.prioritized.issues,
      ))
    )
      throw Error('Scan ownership lost');
  } catch (err) {
    await handleFailure(state, err);
  } finally {
    clearInterval(cancelPoll);
    shutdown?.removeEventListener('abort', onAbort);
    clearTimeout(deadline);
    await poll;
    await rm(folder, { recursive: true, force: true });
  }
}
