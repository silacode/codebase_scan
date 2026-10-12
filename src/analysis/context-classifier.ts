import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { choice, TypeSafeClient } from '@typesafe-ai/sdk';
import pLimit from 'p-limit';
import { config, MAX_CLASSIFIER_CALLS } from '../config.ts';
import { cweImpactMap } from './cwe-impact-map.ts';
import { impactCriteria, repoCriteria, serverFrameworks, uiFrameworks } from './taxonomy.ts';
import type { Finding, ScanContext } from '../scanners/scanner-types.ts';

// Below this, rules win.
const CLASSIFIER_MIN_CONFIDENCE = 0.6;
const CLASSIFIER_CONCURRENCY = 20;
const JEV_REQUEST_TIMEOUT_MS = 2_000;
const JEV_CACHE_TTL_MS = 30 * 24 * 60 * 60_000;
const REPO_CONTEXT_LENGTH = 4_000;
const ADVISORY_SUMMARY_LENGTH = 500;
const ADVISORY_DETAIL_LENGTH = 1_500;

/** The first mapped impact class of the finding's CWEs, or 'other'. */
export function impact(f: Finding) {
  return f.cweIds.map((id) => cweImpactMap[id.replace(/^CWE-/i, '')]).find(Boolean) ?? 'other';
}
// Rules: a bin field → cli; a known web-framework dependency → web_service; a UI framework
// → frontend; anything else → library.
export function repoType(pkg: {
  bin?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}) {
  if (pkg.bin) return 'cli';
  const names = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));
  if (serverFrameworks.some((n) => names.has(n))) return 'web_service';
  if (uiFrameworks.some((n) => names.has(n))) return 'frontend';
  return 'library';
}
/**
 * Ask the typesafe Jev classifier to pick one of `criteria` for `state`. Answers are cached
 * by (model, state, criteria) for 30 days; an answer outside the choices or with a
 * non-finite confidence is an error — the caller decides whether that is fatal.
 */
export async function jevChoice(state: string, criteria: Record<string, string>, ctx: ScanContext) {
  const questions = {
    answer: choice('Choose only from the provided evidence.', criteria),
  };
  const key =
    'jev:' +
    createHash('sha256')
      .update(JSON.stringify([config.typesafeModel, state, questions]))
      .digest('hex');
  const cached = await ctx.cache.get<{ choice: string; confidence: number }>(key);
  if (cached) return cached;
  const data = await new TypeSafeClient({
    apiKey: config.typesafeKey,
    retry: { maxRetries: 0 },
  }).systemOne(
    { state, questions, model: config.typesafeModel },
    { timeout: JEV_REQUEST_TIMEOUT_MS, signal: ctx.signal },
  );
  const answer = data.answers.answer;
  if (!Object.hasOwn(criteria, answer.choice) || !Number.isFinite(answer.confidence))
    throw Error('Invalid Jev answer');
  await ctx.cache.set(key, answer, JEV_CACHE_TTL_MS);
  return answer;
}

/** Upgrade one advisory's findings to Jev's impact class when confident; warn via `warned`. */
async function upgradeFindingImpact(
  f: Finding,
  findings: Finding[],
  ctx: ScanContext,
  warnOnce: () => Promise<void>,
) {
  try {
    const cached = await ctx.cache.get<{ summary?: string; details?: string }>(
      `osv:${f.advisoryId}`,
    );
    const state = JSON.stringify({
      summary: (cached?.summary ?? f.title).slice(0, ADVISORY_SUMMARY_LENGTH),
      details: (cached?.details ?? '').slice(0, ADVISORY_DETAIL_LENGTH),
    });
    const result = await jevChoice(state, impactCriteria, ctx);
    if (result.confidence >= CLASSIFIER_MIN_CONFIDENCE)
      for (const target of findings.filter((x) => x.advisoryId === f.advisoryId))
        target.context = {
          impactClass: result.choice,
          source: 'jev',
          confidence: result.confidence,
        };
  } catch {
    await warnOnce();
  }
}

/**
 * Upgrade impact classes rules call 'other' via Jev, one call per advisory, in batches.
 * Confident answers apply to every finding of that advisory; any failure warns once and
 * keeps the rules answer. Returns warnings to surface (at most one).
 */
async function classifyImpactWithJev(findings: Finding[], ctx: ScanContext): Promise<string[]> {
  const byAdvisory = new Map(
    findings.filter((f) => f.context?.impactClass === 'other').map((f) => [f.advisoryId, f]),
  );
  const items = [...byAdvisory.values()].slice(0, MAX_CLASSIFIER_CALLS - 1);
  let warned = false;
  const warnOnce = async () => {
    if (warned) return;
    warned = true;
    await ctx.progress('Warning: Jev unavailable; rules used');
  };
  const limit = pLimit(CLASSIFIER_CONCURRENCY);
  await Promise.all(
    items.map((f) => limit(() => upgradeFindingImpact(f, findings, ctx, warnOnce))),
  );
  return warned ? ['Jev unavailable; rules used'] : [];
}

/**
 * Attach context to every finding: impact class by rules, upgraded to Jev for the repo type
 * (when TYPESAFE_API_KEY is set) and for advisories rules call 'other' — capped at
 * MAX_CLASSIFIER_CALLS-1 advisories, in batches of 20. Any Jev failure degrades to rules
 * plus a warning; findings are never dropped.
 */
export async function classify(findings: Finding[], ctx: ScanContext) {
  let pkg: {
    name?: string;
    description?: string;
    bin?: unknown;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  } = {};
  try {
    pkg = JSON.parse(await readFile(path.join(ctx.workspaceDir, 'package.json'), 'utf8'));
  } catch {
    /* missing root manifest */
  }
  let type = repoType(pkg),
    source: 'rules' | 'jev' = 'rules';
  for (const f of findings) f.context = { impactClass: impact(f), source: 'rules' };
  const warnings: string[] = [];
  if (!config.typesafeKey) return { findings, repoType: type, source, warnings };
  try {
    const state = JSON.stringify({
      name: pkg.name,
      description: pkg.description,
      bin: pkg.bin,
      dependencies: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }),
      scripts: Object.keys(pkg.scripts ?? {}),
    }).slice(0, REPO_CONTEXT_LENGTH);
    const result = await jevChoice(state, repoCriteria, ctx);
    if (result.confidence >= CLASSIFIER_MIN_CONFIDENCE) {
      type = result.choice;
      source = 'jev';
    }
  } catch {
    warnings.push('Jev unavailable; rules used');
    await ctx.progress('Warning: Jev unavailable; rules used');
  }
  warnings.push(...(await classifyImpactWithJev(findings, ctx)));

  if (findings.some((f) => f.context?.source === 'jev')) source = 'jev';
  return { findings, repoType: type, source, warnings };
}
