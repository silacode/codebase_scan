import path from 'node:path';
import semver from 'semver';
import validateName from 'validate-npm-package-name';
import { z } from 'zod';
import { fetchJson } from '../integrations/http-client.ts';
import type { Finding, ScanContext } from '../scanners/scanner-types.ts';
import type { Issue } from './issue-types.ts';

const REGISTRY_REQUEST_TIMEOUT_MS = 5_000;
const REGISTRY_CACHE_TTL_MS = 24 * 60 * 60_000;

/** POSIX-quote a value for interpolation into a shell command, unless it is provably safe. */
export function shellArg(value: string) {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** npm's own package-name rules, for gating generated install commands. */
export function isNpmName(name: string) {
  return validateName(name).validForNewPackages;
}
/**
 * `npm <verb> …` for a specific project: --prefix for non-root dirs, and one -w flag per
 * workspace only on install (npm update resolves inside the lockfile without them).
 */
function npmCommand(project: Issue['project'], verb: 'install' | 'update', names: string[]) {
  if (
    !names.every((name) =>
      verb === 'install'
        ? isNpmName(name.slice(0, name.lastIndexOf('@'))) &&
          !!semver.valid(name.slice(name.lastIndexOf('@') + 1))
        : isNpmName(name),
    )
  )
    return undefined;
  return [
    'npm',
    ...(project.dir === '.' ? [] : ['--prefix', shellArg(project.dir)]),
    verb,
    ...names.map(shellArg),
    ...(verb === 'install' ? project.workspaces.flatMap((ws) => ['-w', shellArg(ws)]) : []),
  ].join(' ');
}
const rootProject: Issue['project'] = {
  lockfile: 'package-lock.json',
  dir: '.',
  workspaces: [],
};
const registrySchema = z.object({
  versions: z.record(
    z.string(),
    z.object({
      dependencies: z.record(z.string(), z.string()).optional(),
      optionalDependencies: z.record(z.string(), z.string()).optional(),
      peerDependencies: z.record(z.string(), z.string()).optional(),
    }),
  ),
  'dist-tags': z.object({ latest: z.string() }),
});
type RegistryMetadata = z.infer<typeof registrySchema>;
/** Major bumps are 'high'; 0.x minor bumps count as breaking ('medium'); everything else 'low'. */
function upgradeEffort(from: string, to: string): 'low' | 'medium' | 'high' {
  const old = semver.parse(from),
    next = semver.parse(to);
  if (!old || !next) return 'high';
  if (next.major !== old.major) return 'high';
  if (old.major === 0 && next.minor !== old.minor) return 'medium';
  return 'low';
}
/**
 * Decide the fix for one issue group (findings sharing a lockfile and root dependency
 * `direct`), as a ladder:
 *  1. upgrade_direct — `direct` itself is vulnerable and every finding in the group has
 *     a fixed version: install the highest fixed version.
 *  2. refresh_lockfile — every affected parent's range already allows `>= fixed`: an
 *     `npm update` refreshes the lockfile in place.
 *  3. upgrade_parent — the registry offers a newer `direct` that is newer than current,
 *     at least its own fixed target when `direct` is affected, and depends on fixed
 *     versions of each affected child. Registry outage degrades to generic advice.
 *  4. override — no newer release helps: force fixed child versions via npm overrides.
 *  5. no_fix — nothing has a fixed version at all: replace the package.
 */
export async function fixIssue(
  group: Finding[],
  direct: string,
  ctx: Pick<ScanContext, 'cache' | 'signal'>,
  project: Issue['project'] = rootProject,
): Promise<Issue['fix']> {
  const own = group.filter((f) => f.direct && f.package === direct && f.fixedVersion);
  const fixed = group.filter((f) => f.fixedVersion);
  const counts = { fixableCount: fixed.length, unfixableCount: group.length - fixed.length };
  if (!fixed.length)
    return {
      kind: 'no_fix',
      effort: 'high',
      text: `No fixed version is available yet; consider replacing ${[...new Set(group.map((f) => f.package))].join(', ')}.`,
      ...counts,
    };
  const unfixed = [...new Set(group.filter((f) => !f.fixedVersion).map((f) => f.package))];
  const n = counts.unfixableCount;
  const plural = n === 1 ? '' : 's';
  const verb = n === 1 ? 'has' : 'have';
  const pronoun = n === 1 ? 'it' : 'them';
  const note = unfixed.length
    ? `${n} finding${plural} ${verb} no fixed version yet (${unfixed.join(', ')}); consider replacing ${pronoun}`
    : undefined;
  // The version of `direct` at the head of the lockfile path (`name@version`).
  const current = group[0].path[0]?.slice(direct.length + 1) ?? '';
  // A newer target must beat `current`; a prerelease current may jump anywhere, otherwise
  // the target must not itself be a prerelease.
  const isNewVersion = (version: string) =>
    !!semver.valid(current) &&
    !!semver.valid(version) &&
    semver.gt(version, current) &&
    (semver.prerelease(current) !== null || semver.prerelease(version) === null);
  if (own.length && own.length === fixed.length) {
    // Case 1: `direct` is affected itself and fully fixable in place.
    const target = own
      .map((f) => f.fixedVersion!)
      .filter((v) => !!semver.valid(v))
      .sort(semver.rcompare)[0];
    if (target && isNewVersion(target))
      return {
        kind: 'upgrade_direct',
        from: current,
        target,
        baseCommand: npmCommand(rootProject, 'install', [`${direct}@${target}`]),
        command: isNpmName(direct)
          ? npmCommand(project, 'install', [`${direct}@${target}`])
          : undefined,
        effort: upgradeEffort(current, target),
        text: `Upgrade ${direct} to ${target}.`,
        ...(note ? { note } : {}),
        ...counts,
      };
  }
  if (
    // Case 2: parents' declared ranges already admit the fixed versions.
    fixed.every(
      (f) =>
        f.parent?.range &&
        semver.validRange(f.parent.range) &&
        semver.intersects(f.parent.range, `>=${f.fixedVersion}`, { includePrerelease: true }),
    )
  ) {
    const pkgs = [...new Set(fixed.map((f) => f.package))].sort();
    return {
      kind: 'refresh_lockfile',
      baseCommand: npmCommand(rootProject, 'update', pkgs),
      command: npmCommand(project, 'update', pkgs),
      effort: 'low',
      text: `Refresh the lockfile for ${pkgs.join(', ')}.`,
      ...(note ? { note } : {}),
      ...counts,
    };
  }
  // Case 3: find the newest `direct` that satisfies every affected child (registry).
  const newest = fixed
    .map((f) => f.fixedVersion!)
    .filter((v) => !!semver.valid(v))
    .sort(semver.rcompare)[0];
  try {
    const key = `npm:${direct}`;
    const cached = await ctx.cache.get<RegistryMetadata>(key);
    let data: RegistryMetadata;
    if (cached) {
      data = cached;
    } else {
      const payload = registrySchema.safeParse(
        await fetchJson<unknown>(
          `https://registry.npmjs.org/${encodeURIComponent(direct)}`,
          { headers: { Accept: 'application/vnd.npm.install-v1+json' } },
          { timeoutMs: REGISTRY_REQUEST_TIMEOUT_MS, signal: ctx.signal },
        ),
      );
      if (!payload.success) throw Error('Invalid registry metadata');
      data = payload.data;
    }
    await ctx.cache.set(key, data, REGISTRY_CACHE_TTL_MS);
    const children = fixed.filter((f) => f.path.length === 2);
    const ownTarget = own
      .map((f) => f.fixedVersion!)
      .filter((v) => !!semver.valid(v))
      .sort(semver.rcompare)[0];
    const constrained = own.length > 0 || children.length > 0;
    let target: string | undefined;
    if (constrained) {
      target = Object.keys(data.versions)
        .filter(
          (v) =>
            isNewVersion(v) &&
            (own.length === 0 || (!!ownTarget && semver.gte(v, ownTarget))) &&
            children.every((f) => {
              const entry = data.versions[v];
              const ranges = [
                entry.dependencies?.[f.package],
                entry.optionalDependencies?.[f.package],
                entry.peerDependencies?.[f.package],
              ].filter((range): range is string => range !== undefined);
              return ranges.every(
                (range) =>
                  !!semver.validRange(range) &&
                  semver.intersects(range, `>=${f.fixedVersion}`, { includePrerelease: true }),
              );
            }),
        )
        .sort(
          (a, b) =>
            Number(semver.major(a) !== semver.major(current)) -
              Number(semver.major(b) !== semver.major(current)) || semver.compare(a, b),
        )[0];
    } else if (isNewVersion(data['dist-tags'].latest)) {
      target = data['dist-tags'].latest;
    }
    if (!target) {
      // Case 4: pin the fixed child versions with npm overrides instead of upgrading.
      const overrides: Record<string, string> = {};
      for (const f of fixed.filter((item) => !item.direct && item.package !== direct)) {
        const version = f.fixedVersion!;
        if (
          semver.valid(version) &&
          (!overrides[f.package] || semver.gt(version, overrides[f.package].slice(1)))
        )
          overrides[f.package] = `^${version}`;
      }
      const hasOverrides = Object.keys(overrides).length > 0;
      return {
        kind: 'override',
        command:
          hasOverrides && Object.keys(overrides).every(isNpmName) && isNpmName(direct)
            ? JSON.stringify({ overrides }, null, 2)
            : undefined,
        applyTo: path.posix.join(project.dir, 'package.json'),
        baseCommand: hasOverrides
          ? JSON.stringify({ overrides }, null, 2)
          : `No newer ${direct} release fixes its advisories; replace ${direct}.`,
        effort: 'high',
        text: hasOverrides
          ? `No newer ${direct} release removes these versions. Force the fixed versions with npm overrides in ${path.posix.join(project.dir, 'package.json')}, then test ${direct}, or replace ${direct}.`
          : `No newer ${direct} release fixes its advisories; replace ${direct}.`,
        ...(note ? { note } : {}),
        ...counts,
      };
    }
    const verify = group.some((f) => f.path.length > 2);
    const verifyNote = verify ? 'Verify the vulnerable versions are gone after upgrading' : null;
    return {
      kind: 'upgrade_parent',
      from: current,
      target,
      baseCommand: isNpmName(direct)
        ? npmCommand(rootProject, 'install', [`${direct}@${target}`])
        : undefined,
      command: isNpmName(direct)
        ? npmCommand(project, 'install', [`${direct}@${target}`])
        : undefined,
      effort: upgradeEffort(current, target),
      text: `Upgrade ${direct} to ${target}.`,
      ...(verify || note ? { note: [verifyNote, note].filter(Boolean).join('. ') } : {}),
      ...counts,
    };
  } catch {
    return {
      kind: 'upgrade_parent',
      effort: 'high',
      text: `Upgrade ${direct} to a version that depends on ${fixed[0].package} >= ${newest}.`,
      ...(note ? { note } : {}),
      ...counts,
    };
  }
}
