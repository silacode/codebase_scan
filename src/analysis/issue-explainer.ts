import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { config, AI_TOP_ISSUES } from '../config.ts';
import type { Issue } from '../reports/issue-types.ts';
import type { ScanContext } from '../scanners/scanner-types.ts';

const AI_SUMMARY_MAX_LENGTH = 800;
// Oversized entries are dropped, not truncated.
const AI_ISSUE_EXPLANATION_MAX_LENGTH = 500;
const AI_INPUT_TITLE_MAX_LENGTH = 200;
const AI_REQUEST_TIMEOUT_MS = 30_000;
const AI_CACHE_TTL_MS = 24 * 60 * 60_000;

const aiOutputSchema = z.object({
  summary: z.string().max(AI_SUMMARY_MAX_LENGTH),
  issues: z.array(z.object({ issueId: z.string(), whyItMatters: z.string() })),
});
/**
 * Validate an OpenAI structured output: the shape must parse and the summary must fit;
 * unknown, duplicate or oversized issue entries are dropped rather than fatal.
 */
export function validateAI(value: unknown, allowed: Set<string>) {
  const parsed = aiOutputSchema.safeParse(value);
  if (!parsed.success) throw Error('Invalid AI summary');
  const seen = new Set<string>();
  const issues: { issueId: string; whyItMatters: string }[] = [];
  for (const item of parsed.data.issues) {
    if (
      !allowed.has(item.issueId) ||
      seen.has(item.issueId) ||
      item.whyItMatters.length > AI_ISSUE_EXPLANATION_MAX_LENGTH
    )
      continue;
    seen.add(item.issueId);
    issues.push({ issueId: item.issueId, whyItMatters: item.whyItMatters });
  }
  return { summary: parsed.data.summary, issues };
}
/**
 * Rewrite the report summary and top-issue rationale with OpenAI, strictly grounded in the
 * facts sent (validated; issue ids must be ours), cached by model+facts for a day. Any
 * failure falls back to template text with a fallbackReason — never fails the scan.
 */
export async function explain(issues: Issue[], summary: string, ctx: ScanContext) {
  if (!config.openaiKey)
    return { summary, ai: { used: false, fallbackReason: 'OPENAI_API_KEY not set' } };
  const top = issues.slice(0, AI_TOP_ISSUES);
  const facts = top.map((i) => ({
    id: i.id,
    packages: i.findings.map((f) => ({
      name: f.package,
      version: f.version,
      severity: f.severity,
      kev: !!f.exploit?.kev,
      epss: f.exploit?.epss,
      dev: f.dev,
      direct: f.direct,
      impact: f.context?.impactClass,
      title: f.title.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, AI_INPUT_TITLE_MAX_LENGTH),
    })),
    fix: { kind: i.fix.kind, target: i.fix.target, effort: i.fix.effort },
  }));
  const input = JSON.stringify(facts);
  const key =
    'ai:' +
    createHash('sha256')
      .update(config.openaiModel + input)
      .digest('hex');
  try {
    const cached = await ctx.cache.get<unknown>(key);
    let raw: unknown = cached;
    if (!cached) {
      const response = await new OpenAI({
        apiKey: config.openaiKey,
        timeout: AI_REQUEST_TIMEOUT_MS,
        /** Use template fallbacks rather than additional SDK retries when explanation fails. */
        maxRetries: 0,
      }).responses.parse(
        {
          model: config.openaiModel,
          instructions:
            'Explain only the given facts; do not add vulnerabilities, versions, or commands. Use plain language.',
          input,
          text: { format: zodTextFormat(aiOutputSchema, 'scan_explanation') },
        },
        { signal: ctx.signal },
      );
      raw = response.output_parsed;
    }
    const validated = validateAI(raw, new Set(top.map((i) => i.id)));
    if (!cached) await ctx.cache.set(key, validated, AI_CACHE_TTL_MS);
    for (const entry of validated.issues) {
      const issue = issues.find((i) => i.id === entry.issueId)!;
      issue.whyItMatters = entry.whyItMatters;
      issue.whySource = 'ai';
    }
    return { summary: validated.summary, ai: { used: true, model: config.openaiModel } };
  } catch {
    await ctx.progress('Warning: OpenAI unavailable; using template text');
    return {
      summary,
      ai: { used: false, fallbackReason: 'OpenAI failed or returned invalid output' },
    };
  }
}
