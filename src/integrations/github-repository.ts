import { constants as HTTP } from 'node:http2';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import {
  config,
  MAX_REPO_KB,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_EXTRACT_BYTES,
  MAX_LOCKFILE_BYTES,
} from '../config.ts';
import { ScanError } from '../errors.ts';
import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { z } from 'zod';
import { isValidRef, isValidRepoName, parseRepoUrlSafe } from '../contracts/repo-url.ts';
import { fetchWithRetry } from './http-client.ts';
// Fail fast before committing to a scan.
const GITHUB_METADATA_TIMEOUT_MS = 1_500;
// Archives need more time than metadata.
const GITHUB_DOWNLOAD_TIMEOUT_MS = 60_000;

const GitHub = Octokit.plugin(retry);
const GITHUB_API_VERSION = '2022-11-28';

function github() {
  return new GitHub({
    ...(config.githubToken ? { auth: config.githubToken } : {}),
    userAgent: 'ai-scan-review',
  });
}
/** Read a header from Octokit (plain object) or fetch (Headers) shapes. */
function headerOf(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  if ('get' in headers && typeof (headers as Headers).get === 'function')
    return (headers as Headers).get(name);
  return (headers as Record<string, string | undefined>)[name] ?? null;
}
/** The retryable quota error; includes the reset time when GitHub reports one. */
function quotaError(headers: unknown) {
  const reset = Number(headerOf(headers, 'x-ratelimit-reset'));
  return new ScanError(
    'RATE_LIMITED',
    `GitHub quota exhausted until ${Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : 'later'}`,
    true,
  );
}
/**
 * Accept only plain `https?://github.com/owner/repo(/tree/<ref>)?` URLs. Everything else —
 * other hosts, ports, credentials, query, hash — is rejected so the fetch surface stays
 * predictable. Throws ScanError('INVALID_URL', 400).
 */
export function parseRepoUrl(input: string) {
  const parsed = parseRepoUrlSafe(input);
  if (!parsed)
    throw new ScanError(
      'INVALID_URL',
      'Provide a public github.com/owner/repo URL',
      false,
      HTTP.HTTP_STATUS_BAD_REQUEST,
    );
  return parsed;
}
/** Map Octokit failures: 404 → REPO_NOT_FOUND, quota → RATE_LIMITED, rest → unavailable. */
function classifyGitHubError(error: unknown): ScanError {
  const status = (error as { status?: unknown })?.status;
  const headers = (error as { response?: { headers?: unknown } })?.response?.headers;
  if (status === HTTP.HTTP_STATUS_NOT_FOUND)
    return new ScanError(
      'REPO_NOT_FOUND',
      'Repository or ref not found',
      false,
      HTTP.HTTP_STATUS_NOT_FOUND,
    );
  if (
    (status === HTTP.HTTP_STATUS_FORBIDDEN || status === HTTP.HTTP_STATUS_TOO_MANY_REQUESTS) &&
    headerOf(headers, 'x-ratelimit-remaining') === '0'
  )
    return quotaError(headers);
  return new ScanError(
    'GITHUB_UNAVAILABLE',
    typeof status === 'number' ? `GitHub returned ${status}` : 'GitHub is unavailable',
    true,
  );
}
const repoMetaSchema = z.object({
  private: z.boolean(),
  size: z.number().int().min(0),
  default_branch: z.string(),
});
/**
 * Validate names, then resolve a ref (or the default branch) to a commit SHA via the
 * GitHub API. Private repos surface as REPO_NOT_FOUND so they are indistinguishable from
 * missing ones; quota exhaustion as RATE_LIMITED (retryable); other failures as
 * GITHUB_UNAVAILABLE (retryable).
 */
export async function resolveRepo(owner: string, repo: string, ref?: string) {
  if (!isValidRepoName(owner, repo))
    throw new ScanError('INVALID_URL', 'Invalid repository', false, HTTP.HTTP_STATUS_BAD_REQUEST);
  const client = github();
  const headers = { 'X-GitHub-Api-Version': GITHUB_API_VERSION };
  const timeout = { signal: AbortSignal.timeout(GITHUB_METADATA_TIMEOUT_MS) };
  let meta: unknown;
  try {
    ({ data: meta } = await client.rest.repos.get({ owner, repo, headers, request: timeout }));
  } catch (error) {
    throw classifyGitHubError(error);
  }
  // Shape-check before deciding 404 vs 503: a malformed payload is our problem, not the repo's.
  const parsed = repoMetaSchema.safeParse(meta);
  if (!parsed.success)
    throw new ScanError('GITHUB_UNAVAILABLE', 'Invalid GitHub repository metadata', true);
  const { private: isPrivate, size, default_branch: defaultBranch } = parsed.data;
  if (isPrivate)
    throw new ScanError(
      'REPO_NOT_FOUND',
      'Repository not found',
      false,
      HTTP.HTTP_STATUS_NOT_FOUND,
    );
  if (size > MAX_REPO_KB)
    throw new ScanError(
      'REPO_TOO_LARGE',
      'Repository exceeds 1 GB',
      false,
      HTTP.HTTP_STATUS_UNPROCESSABLE_ENTITY,
    );
  const branch = ref ?? defaultBranch;
  if (!isValidRef(branch))
    throw new ScanError('INVALID_URL', 'Invalid ref', false, HTTP.HTTP_STATUS_BAD_REQUEST);
  // Pin the scan to an immutable SHA, never a moving branch name. The `sha` media type
  // returns the bare 40-char SHA as text (typed as the JSON shape, hence the cast).
  let commitSha: string;
  try {
    const { data } = await client.rest.repos.getCommit({
      owner,
      repo,
      ref: branch,
      headers,
      mediaType: { format: 'sha' },
      request: { signal: AbortSignal.timeout(GITHUB_METADATA_TIMEOUT_MS) },
    });
    commitSha = String(data).trim();
  } catch (error) {
    throw classifyGitHubError(error);
  }
  if (!/^[a-f0-9]{40}$/.test(commitSha))
    throw new ScanError('GITHUB_UNAVAILABLE', 'Invalid commit SHA from GitHub', true);
  return {
    owner,
    repo,
    ref: branch,
    commitSha,
    sizeKb: size,
    defaultBranch,
  };
}
/**
 * Download the repo tarball for `sha` and extract it under `destDir`, with resource
 * guardrails: links are dropped (a tar link can write anywhere), files are capped at
 * MAX_FILE_BYTES (lockfiles at MAX_LOCKFILE_BYTES — they are needed even when huge), and
 * the running totals bomb out at MAX_FILES / MAX_EXTRACT_BYTES. Returns what was skipped
 * so the scan can report honest coverage.
 */
export async function downloadSnapshot(
  owner: string,
  repo: string,
  sha: string,
  destDir: string,
  signal: AbortSignal,
) {
  if (!isValidRepoName(owner, repo) || !/^[a-f0-9]{40}$/.test(sha))
    throw new ScanError('INVALID_URL', 'Invalid snapshot', false, HTTP.HTTP_STATUS_BAD_REQUEST);
  const response = await fetchWithRetry(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${sha}`,
    {
      headers: {
        'User-Agent': 'ai-scan-review',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(config.githubToken ? { Authorization: `Bearer ${config.githubToken}` } : {}),
      },
    },
    { timeoutMs: GITHUB_DOWNLOAD_TIMEOUT_MS, signal },
  );
  if (
    (response.status === HTTP.HTTP_STATUS_FORBIDDEN ||
      response.status === HTTP.HTTP_STATUS_TOO_MANY_REQUESTS) &&
    response.headers.get('x-ratelimit-remaining') === '0'
  )
    throw quotaError(response.headers);
  if (!response.ok || !response.body)
    throw new ScanError('FETCH_FAILED', `Snapshot download failed (${response.status})`, true);
  let files = 0,
    bytes = 0,
    symlinks = 0,
    largeFiles = 0;
  const skippedLockfiles: string[] = [];
  // strip: 1 drops GitHub's `owner-repo-sha/` top folder.
  const extractor = tar.x({
    cwd: destDir,
    strip: 1,
    filter: (_path, entry) => {
      if (!('type' in entry)) return false;
      // Hard/symlinks would write outside destDir; count and drop them.
      if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
        symlinks++;
        return false;
      }
      if (entry.type !== 'File') return entry.type === 'Directory';
      const lockfile = _path.split('/').at(-1) === 'package-lock.json';
      if (entry.size > (lockfile ? MAX_LOCKFILE_BYTES : MAX_FILE_BYTES)) {
        largeFiles++;
        if (lockfile) skippedLockfiles.push(_path.split('/').slice(1).join('/'));
        return false;
      }
      // Running totals, not per-entry checks: the caps bind the whole extraction.
      files++;
      bytes += entry.size;
      if (files > MAX_FILES || bytes > MAX_EXTRACT_BYTES)
        throw new ScanError('FETCH_FAILED', 'Snapshot extraction limit exceeded', false);
      return true;
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      extractor,
      { signal },
    );
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError('FETCH_FAILED', 'Snapshot could not be extracted', true);
  }
  return { files, bytes, skipped: { symlinks, largeFiles, lockfiles: skippedLockfiles } };
}
