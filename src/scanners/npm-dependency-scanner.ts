import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import semver from 'semver';
import pLimit from 'p-limit';
import { Arborist, type ArboristNode } from '@npmcli/arborist';
import { DEPENDENCY_SCAN_TIMEOUT_MS, MAX_LOCKFILE_BYTES, MAX_PACKAGES } from '../config.ts';
import { z } from 'zod';
import { fetchJson } from '../integrations/http-client.ts';
import type { ScannerAdapter, ScanContext, Finding, AdapterResult } from './scanner-types.ts';

// OSV allows ≤1000 queries per request.
const OSV_QUERY_BATCH_SIZE = 1_000;
const OSV_DETAIL_CONCURRENCY = 10;
const OSV_REQUEST_TIMEOUT_MS = 10_000;
const OSV_ADVISORY_CACHE_TTL_MS = 24 * 60 * 60_000;
// 16 hex chars: compact, collision-safe enough.
const FINDING_ID_HASH_LENGTH = 16;
const MAX_ADVISORY_REFERENCES = 5;

export type GraphNode = {
  name: string;
  version: string;
  location: string;
  dev: boolean;
  direct: boolean;
  introducedBy: string[];
  introducerDev: boolean;
  introducerWorkspaces?: string[];
  path: string[];
  parent?: { name: string; range: string };
};
type UsableNode = ArboristNode & { version: string };
/** Versioned, non-link nodes only — links and stubs have no installable version to match. */
function usable(node: ArboristNode | null): node is UsableNode {
  return !!node && !node.isLink && !!node.version;
}
/**
 * Load a lockfile's dependency graph from Arborist's virtual tree (no install): real npm
 * resolution for v1/v2/v3 lockfiles. Each node carries the shortest dependency path from
 * a root, whether a root declares it directly, whether it is dev-only, and which
 * workspace(s) introduced it — everything the report needs to explain and fix a
 * vulnerable version.
 */
export async function loadNodes(lockDir: string): Promise<GraphNode[]> {
  const tree = await new Arborist({ path: lockDir }).loadVirtual();
  // Anything outside node_modules is a workspace manifest (a root); '' is the root itself.
  const isRootLoc = (location: string) =>
    !location.includes('node_modules/') && !location.startsWith('node_modules/');
  // Breadth-first walk; `routes` keeps, per package location × root, the shortest chain
  // found so far (BFS visits longer chains last, so the first chain recorded wins).
  const result = new Map<string, GraphNode>();
  const routes = new Map<
    string,
    Map<string, { chain: string[]; parent?: { name: string; range: string } }>
  >();
  const rootDev = new Map<string, boolean>();
  const rootLocations = new Map<string, Set<string>>();
  const queue: {
    node: UsableNode;
    root: string;
    chain: string[];
    parent?: { name: string; range: string };
  }[] = [];
  for (const [location, node] of tree.inventory) {
    if (!isRootLoc(location)) continue;
    for (const edge of node.edgesOut.values()) {
      const target = edge.to;
      if (!usable(target)) continue;
      const locations = rootLocations.get(target.name) ?? new Set<string>();
      locations.add(location);
      rootLocations.set(target.name, locations);
      rootDev.set(target.name, target.dev);
      queue.push({
        node: target,
        root: target.name,
        chain: [`${target.name}@${target.version}`],
      });
    }
  }
  for (let index = 0; index < queue.length; index++) {
    const { node, root, chain, parent } = queue[index];
    const paths = routes.get(node.location) ?? new Map();
    if (paths.has(root) && paths.get(root)!.chain.length <= chain.length) continue;
    paths.set(root, { chain, parent });
    routes.set(node.location, paths);
    result.set(node.location, {
      name: node.name,
      version: node.version,
      location: node.location,
      dev: !!node.dev,
      direct: !parent,
      introducedBy: [],
      introducerDev: !!node.dev,
      path: chain,
      parent,
    });
    if (result.size >= MAX_PACKAGES) break;
    for (const edge of node.edgesOut.values()) {
      // A package's own devDependencies don't gate its children; roots already followed theirs.
      if (edge.type === 'dev') continue;
      const child = edge.to;
      if (!usable(child)) continue;
      queue.push({
        node: child,
        root,
        chain: [...chain, `${child.name}@${child.version}`],
        parent: { name: node.name, range: edge.spec },
      });
    }
  }
  // Representative route per node: prefer a production introducer, then the shortest
  // chain, then name order — that decides `direct`, dev-ness, and which workspaces the
  // fix command targets.
  return [...result.values()].map((n) => {
    const ranked = [...(routes.get(n.location)?.entries() ?? [])].sort(
      (a, b) =>
        Number(rootDev.get(a[0])) - Number(rootDev.get(b[0])) ||
        a[1].chain.length - b[1].chain.length ||
        a[0].localeCompare(b[0]),
    );
    const chosen = ranked[0][1];
    return {
      ...n,
      direct: chosen.chain.length === 1,
      introducedBy: ranked.map(([name]) => name),
      introducerDev: !!rootDev.get(ranked[0][0]),
      // '' is the repo root; any other introducer location is a workspace path.
      ...(rootLocations.get(ranked[0][0])?.has('')
        ? {}
        : { introducerWorkspaces: [...(rootLocations.get(ranked[0][0]) ?? [])].sort() }),
      path: chosen.chain,
      parent: chosen.parent,
    };
  });
}
const osvBatchSchema = z.object({
  results: z.array(
    z.object({
      vulns: z.array(z.object({ id: z.string() })).optional(),
      next_page_token: z.string().optional(),
    }),
  ),
});
const osvVulnSchema = z.object({
  id: z.string(),
  aliases: z.array(z.string()).optional(),
  summary: z.string().optional(),
  details: z.string().optional(),
  affected: z
    .array(
      z.object({
        package: z.object({ name: z.string(), ecosystem: z.string() }).optional(),
        ranges: z
          .array(
            z.object({
              type: z.string(),
              events: z.array(
                z.object({ introduced: z.string().optional(), fixed: z.string().optional() }),
              ),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  database_specific: z
    .object({ severity: z.string().optional(), cwe_ids: z.array(z.string()).optional() })
    .optional(),
  references: z.array(z.object({ url: z.string() })).optional(),
});
export type Vuln = z.infer<typeof osvVulnSchema>;
/**
 * The earliest OSV `fixed` version that applies to `version`: a fix only counts while the
 * affected range is `active` (the last `introduced` boundary is at or below `version`) and
 * only if it is strictly greater. Undefined when nothing fixes this install.
 */
export function fixedVersion(vuln: Vuln, name: string, version: string): string | undefined {
  const candidates: string[] = [];
  for (const affected of vuln.affected ?? []) {
    if (affected.package?.name !== name || affected.package.ecosystem.toLowerCase() !== 'npm')
      continue;
    for (const range of affected.ranges ?? []) {
      if (!['SEMVER', 'ECOSYSTEM'].includes(range.type)) continue;
      let active = false;
      for (const event of range.events) {
        if (
          event.introduced !== undefined &&
          (event.introduced === '0' ||
            (semver.valid(event.introduced) && semver.lte(event.introduced, version)))
        )
          active = true;
        if (event.fixed && active) {
          if (semver.valid(event.fixed) && semver.gt(event.fixed, version))
            candidates.push(event.fixed);
          active = false;
        }
      }
    }
  }
  return candidates.sort(semver.compare)[0];
}
/**
 * Deduplicate findings for the same lockfile/package/version whose advisories overlap —
 * one vulnerability is often reported under several ids (GHSA ↔ CVE). Scanning backwards,
 * each finding merges into the last matching earlier group so aliases accumulate.
 */
export function mergeAliases(findings: Finding[]): Finding[] {
  const groups: Finding[] = [];
  for (const finding of findings) {
    let current = finding;
    for (let i = groups.length - 1; i >= 0; i--) {
      const match = groups[i];
      if (
        match.lockfile !== current.lockfile ||
        match.package !== current.package ||
        match.version !== current.version ||
        ![match.advisoryId, ...match.aliases].some((a) =>
          [current.advisoryId, ...current.aliases].includes(a),
        )
      )
        continue;
      match.aliases = [
        ...new Set([...match.aliases, current.advisoryId, ...current.aliases]),
      ].sort();
      match.fixedVersion ??= current.fixedVersion;
      current = match;
      groups.splice(i, 1);
    }
    groups.push(current);
  }
  return groups;
}
/** Recursively list lockfiles, manifests and unsupported lockfile kinds under `folder`. */
async function discover(
  folder: string,
  relative = '',
): Promise<{ lockfiles: string[]; manifests: string[]; unsupported: string[] }> {
  const result = {
    lockfiles: [] as string[],
    manifests: [] as string[],
    unsupported: [] as string[],
  };
  for (const item of await readdir(path.join(folder, relative), { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const name = path.posix.join(relative, item.name);
    if (item.isDirectory() && !['node_modules', '.git'].includes(item.name)) {
      const inner = await discover(folder, name);
      result.lockfiles.push(...inner.lockfiles);
      result.manifests.push(...inner.manifests);
      result.unsupported.push(...inner.unsupported);
    } else if (item.isFile()) {
      if (item.name === 'package-lock.json') result.lockfiles.push(name);
      if (item.name === 'package.json') result.manifests.push(name);
      if (['yarn.lock', 'pnpm-lock.yaml'].includes(item.name)) result.unsupported.push(name);
    }
  }
  return result;
}
/**
 * The npm adapter: discover lockfiles in the workspace, resolve the dependency graph,
 * and query OSV for vulnerable versions. Coverage records every deliberate skip
 * (unsupported lockfile kinds, manifests without a lockfile, oversize lockfiles) so the
 * report can say what was not scanned and why.
 */
export const npmDependencies: ScannerAdapter = {
  name: 'npm',
  category: 'dependency',
  timeoutMs: DEPENDENCY_SCAN_TIMEOUT_MS,
  resourceClass: 'light',
  async run(ctx: ScanContext): Promise<AdapterResult> {
    const found = await discover(ctx.workspaceDir);
    const coverage: AdapterResult['coverage'] = { scanned: [], notScanned: [] };
    for (const file of found.unsupported)
      coverage.notScanned.push({ what: file, why: 'not supported in v1' });
    for (const file of found.manifests)
      if (
        !found.lockfiles.includes(path.posix.join(path.posix.dirname(file), 'package-lock.json')) &&
        !found.lockfiles.includes('package-lock.json')
      )
        coverage.notScanned.push({ what: file, why: 'versions unknown without a lockfile' });
    if (!found.lockfiles.length)
      coverage.notScanned.push({
        what: 'npm dependencies',
        why: 'no package-lock.json found; versions unknown without a lockfile',
      });

    const nodes: { node: GraphNode; lockfile: string }[] = [];
    for (const lockfile of found.lockfiles) {
      if (nodes.length >= MAX_PACKAGES) {
        coverage.notScanned.push({
          what: lockfile,
          why: `package limit reached (${MAX_PACKAGES.toLocaleString('en-US')})`,
        });
        continue;
      }
      const full = path.join(ctx.workspaceDir, lockfile);
      if ((await stat(full)).size > MAX_LOCKFILE_BYTES) {
        coverage.notScanned.push({
          what: lockfile,
          why: `lockfile exceeds ${MAX_LOCKFILE_BYTES / 1024 ** 2} MB`,
        });
        continue;
      }
      let parsed: GraphNode[];
      try {
        parsed = await loadNodes(path.dirname(full));
      } catch {
        coverage.notScanned.push({ what: lockfile, why: 'invalid lockfile JSON' });
        continue;
      }
      nodes.push(
        ...parsed.slice(0, MAX_PACKAGES - nodes.length).map((node) => ({ node, lockfile })),
      );
      if (nodes.length >= MAX_PACKAGES)
        coverage.notScanned.push({
          what: lockfile,
          why: `package limit reached (${MAX_PACKAGES.toLocaleString('en-US')})`,
        });
      coverage.scanned.push(lockfile);
    }

    await ctx.progress(`Found ${found.lockfiles.length} lockfiles, ${nodes.length} packages`);
    const findings: Finding[] = [];
    // OSV querybatch takes at most 1000 queries and page_token-paginates results per query.
    for (let start = 0; start < nodes.length; start += OSV_QUERY_BATCH_SIZE) {
      const chunk = nodes.slice(start, start + OSV_QUERY_BATCH_SIZE);
      const queries = chunk.map(({ node }) => ({
        package: { name: node.name, ecosystem: 'npm' },
        version: node.version,
      }));
      let pending = queries.map((query, i) => ({
        query,
        i,
        token: undefined as string | undefined,
      }));
      while (pending.length) {
        const body = {
          queries: pending.map(({ query, token }) => ({
            ...query,
            ...(token ? { page_token: token } : {}),
          })),
        };
        const payload = osvBatchSchema.safeParse(
          await fetchJson<unknown>(
            'https://api.osv.dev/v1/querybatch',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            },
            { timeoutMs: OSV_REQUEST_TIMEOUT_MS, signal: ctx.signal },
          ),
        );
        if (!payload.success || payload.data.results.length !== pending.length)
          throw new Error('Invalid OSV batch response');
        const batch = payload.data;
        const ids = [...new Set(batch.results.flatMap((r) => r.vulns?.map((v) => v.id) ?? []))];
        // Advisory details, 10 at a time, cached for a day: OSV JSON is big and slow.
        const details = new Map<string, Vuln>();
        const limit = pLimit(OSV_DETAIL_CONCURRENCY);
        await Promise.all(
          ids.map((id) =>
            limit(async () => {
              const key = `osv:${id}`;
              const cached = await ctx.cache.get<unknown>(key);
              const parsed = osvVulnSchema.safeParse(
                cached ??
                  (await fetchJson<unknown>(
                    `https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`,
                    {},
                    { timeoutMs: OSV_REQUEST_TIMEOUT_MS, signal: ctx.signal },
                  )),
              );
              if (!parsed.success || parsed.data.id !== id)
                throw new Error(`Invalid OSV advisory ${id}`);
              details.set(id, parsed.data);
              await ctx.cache.set(key, parsed.data, OSV_ADVISORY_CACHE_TTL_MS);
            }),
          ),
        );
        batch.results.forEach((result, index) => {
          const { node, lockfile } = chunk[pending[index].i];
          for (const brief of result.vulns ?? []) {
            const vuln = details.get(brief.id);
            if (!vuln) throw new Error(`Missing OSV advisory ${brief.id}`);
            // OSV malicious-package advisories (MAL-) carry no severity; treat as critical.
            const malicious = vuln.id.startsWith('MAL-');
            const severity = malicious
              ? 'critical'
              : vuln.database_specific?.severity?.toLowerCase();
            findings.push({
              id: createHash('sha256')
                .update(`dependency|${vuln.id}|${node.name}@${node.version}|${lockfile}`)
                .digest('hex')
                .slice(0, FINDING_ID_HASH_LENGTH),
              category: 'dependency',
              advisoryId: vuln.id,
              aliases: vuln.aliases ?? [],
              title: malicious
                ? `Malicious package: ${vuln.summary ?? vuln.id}`
                : (vuln.summary ?? vuln.id),
              severity:
                severity === 'critical' || severity === 'high' || severity === 'low'
                  ? severity
                  : 'medium',
              package: node.name,
              version: node.version,
              lockfile,
              direct: node.direct,
              dev: node.dev,
              introducedBy: node.introducedBy,
              introducerDev: node.introducerDev,
              introducerWorkspaces: node.introducerWorkspaces,
              path: node.path,
              parent: node.parent,
              fixedVersion: fixedVersion(vuln, node.name, node.version),
              cweIds: vuln.database_specific?.cwe_ids ?? [],
              references: (vuln.references ?? [])
                .slice(0, MAX_ADVISORY_REFERENCES)
                .map((r) => r.url),
            });
          }
        });
        // Carry over only the queries OSV says continue on a next page.
        pending = batch.results.flatMap((r, index) =>
          r.next_page_token ? [{ ...pending[index], token: r.next_page_token }] : [],
        );
      }
    }

    const merged = mergeAliases(findings);
    await ctx.progress(`OSV: ${merged.length} vulnerable package versions`);
    return {
      findings: merged,
      coverage,
      stats: { packages: nodes.length, lockfiles: coverage.scanned.length },
    };
  },
};
