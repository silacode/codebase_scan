import { z } from 'zod';

// Consistent bound before sending refs to GitHub.
export const MAX_REF_LENGTH = 255;

// GitHub's own name rules, shared backend↔frontend so validation can't drift.
const ownerRe = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const repoRe = /^[A-Za-z0-9._-]{1,100}$/;
const refRe = /^-|\s|\.\./;

export type ParsedRepoUrl = { owner: string; repo: string; ref?: string };

/** Pure parse of `https?://github.com/owner/repo(/tree/<ref>)?`; null when invalid. */
export function parseRepoUrlSafe(input: string): ParsedRepoUrl | null {
  try {
    const url = new URL(input);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !['github.com', 'www.github.com'].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    const segments = url.pathname.split('/').filter(Boolean);
    if (
      segments.length < 2 ||
      (segments.length > 2 && (segments[2] !== 'tree' || segments.length < 4))
    )
      return null;
    const [owner, rawRepo] = segments;
    const repo = rawRepo.replace(/\.git$/, '');
    const ref = segments.length > 2 ? segments.slice(3).join('/') : undefined;
    if (
      !ownerRe.test(owner) ||
      !repoRe.test(repo) ||
      repo === '.' ||
      repo === '..' ||
      (rawRepo !== repo && !rawRepo.endsWith('.git')) ||
      (ref !== undefined && (ref.length > MAX_REF_LENGTH || !ref || refRe.test(ref)))
    )
      return null;
    return { owner, repo, ...(ref ? { ref } : {}) };
  } catch {
    return null;
  }
}

export const isValidRepoUrl = (value: string) => parseRepoUrlSafe(value) !== null;

export const isValidRepoName = (owner: string, repo: string) =>
  ownerRe.test(owner) && repoRe.test(repo) && repo !== '.' && repo !== '..';

export const isValidRef = (ref: string) =>
  !!ref && ref.length <= MAX_REF_LENGTH && !refRe.test(ref);

/** Shared submit validation; Fastify and react-hook-form both consume this. */
export const repoUrlSchema = z.string().refine(isValidRepoUrl, {
  message: 'Provide a public github.com/owner/repo URL',
});
