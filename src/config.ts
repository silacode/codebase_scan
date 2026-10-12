import { z } from 'zod';

/** Env parsing with Zod; fails fast naming the bad variable like before. */
const envSchema = z.object({
  DATABASE_URL: z.string().default('postgres://scan:scan@localhost:5433/scan'),
  /** Let local API startup work without a port override. */
  PORT: z.coerce.number().int().min(1).default(8080),
  ROLE: z.enum(['api', 'worker', 'all']).default('all'),
  /** Start with bounded per-process scan parallelism. */
  WORKER_SLOTS: z.coerce.number().int().min(1).default(4),
  /** Shed new submissions before queued scans accumulate unchecked. */
  MAX_QUEUED: z.coerce.number().int().min(1).default(32),
  GITHUB_TOKEN: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default('gpt-5-mini'),
  TYPESAFE_API_KEY: z.string().default(''),
  TYPESAFE_MODEL: z.string().default('jev-1.13.0'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) throw new Error(`Invalid ${String(parsed.error.issues[0]?.path[0] ?? 'env')}`);
const env = parsed.data;

export const config = {
  databaseUrl: env.DATABASE_URL,
  port: env.PORT,
  role: env.ROLE,
  workerSlots: env.WORKER_SLOTS,
  maxQueued: env.MAX_QUEUED,
  githubToken: env.GITHUB_TOKEN || '',
  openaiKey: env.OPENAI_API_KEY || '',
  openaiModel: env.OPENAI_MODEL || 'gpt-5-mini',
  typesafeKey: env.TYPESAFE_API_KEY || '',
  typesafeModel: env.TYPESAFE_MODEL || 'jev-1.13.0',
};

// Bump SCANNER_VERSION when findings change shape — it keys result reuse.
export const SCANNER_VERSION = '1.1.0';

/** Give transient scan failures another chance without retrying indefinitely. */
export const MAX_ATTEMPTS = 3;
/** Stop work that exceeds the scan's total time budget. */
export const SCAN_DEADLINE_MS = 300_000;
/** Detect stale queue ownership when heartbeats stop arriving. */
export const SCAN_HEARTBEAT_SECONDS = 30;
// Let the app finish before the queue expires the attempt.
const SCAN_ATTEMPT_EXPIRY_GRACE_SECONDS = 30;
/** Expire stuck attempts after the deadline plus queue cleanup grace. */
export const SCAN_ATTEMPT_EXPIRY_SECONDS =
  SCAN_DEADLINE_MS / 1_000 + SCAN_ATTEMPT_EXPIRY_GRACE_SECONDS;
/** Reserve only part of the scan deadline for dependency matching. */
export const DEPENDENCY_SCAN_TIMEOUT_MS = 120_000;
/** Reuse recent successful results instead of rescanning unchanged commits. */
export const RESULT_REUSE_MS = 24 * 60 * 60_000;
/** Retain replay keys long enough to prevent repeated submissions. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
/** Reject oversized repositories before downloading their snapshots. */
export const MAX_REPO_KB = 1_048_576;
/** Skip large ordinary files to limit per-file extraction work. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Limit filesystem work when archives contain many small files. */
export const MAX_FILES = 100_000;
/** Bound total extracted data even when individual files are small. */
export const MAX_EXTRACT_BYTES = 2 * 1024 ** 3;
/** Allow larger lockfiles needed for scanning while still bounding their size. */
export const MAX_LOCKFILE_BYTES = 20 * 1024 ** 2;
/** Bound graph traversal and advisory lookups for very large lockfiles. */
export const MAX_PACKAGES = 20_000;
/** Reject oversized API requests before parsing untrusted JSON. */
export const MAX_BODY_BYTES = 16 * 1024;
/** Cap optional classifier requests when many advisories need context. */
export const MAX_CLASSIFIER_CALLS = 200;
/** Limit optional explanations to the highest-priority issues. */
export const AI_TOP_ISSUES = 25;
