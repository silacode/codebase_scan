import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as tar from 'tar';

export const realFetch = globalThis.fetch;
let archive: Buffer, withoutLock: Buffer, monorepoArchive: Buffer;
export let folder: string;
export const sha = (repo: string) => createHash('sha1').update(repo).digest('hex');
export function stub(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const u = new URL(String(url));
  if (['localhost', '127.0.0.1'].includes(u.hostname)) return realFetch(url, init);
  if (u.hostname === 'api.github.com') {
    const parts = u.pathname.split('/');
    const repo = parts[3];
    if (repo === 'doesnotexist') return Promise.resolve(new Response('', { status: 404 }));
    if (parts.length === 4)
      return Promise.resolve(
        Response.json({ private: false, size: 100, default_branch: 'master' }),
      );
    if (parts[4] === 'commits') return Promise.resolve(new Response(sha(repo)));
    if (parts[4] === 'tarball')
      return Promise.resolve(
        new Response(
          Uint8Array.from(
            repo === 'is' ? withoutLock : repo === 'monorepo' ? monorepoArchive : archive,
          ),
        ),
      );
  }
  if (u.hostname === 'api.osv.dev') {
    if (u.pathname === '/v1/querybatch') {
      const body = JSON.parse(String(init?.body)) as {
        queries: { package: { name: string }; version: string }[];
      };
      return Promise.resolve(
        Response.json({
          results: body.queries.map((q) => ({
            vulns:
              q.package.name === 'parent'
                ? [{ id: 'GHSA-TEST' }]
                : q.package.name === 'shared'
                  ? [{ id: 'GHSA-CHILD' }]
                  : [],
          })),
        }),
      );
    }
    const id = u.pathname.split('/').at(-1)!;
    return Promise.resolve(
      Response.json({
        id,
        aliases: [id === 'GHSA-TEST' ? 'CVE-2020-1111' : 'CVE-2020-2222'],
        summary: id === 'GHSA-TEST' ? 'Parent security flaw' : 'Child security flaw',
        database_specific: { severity: 'HIGH', cwe_ids: ['CWE-400'] },
        affected: [
          {
            package: { name: id === 'GHSA-TEST' ? 'parent' : 'shared', ecosystem: 'npm' },
            ranges: [
              {
                type: 'SEMVER',
                events: [{ introduced: '0' }, { fixed: id === 'GHSA-TEST' ? '1.1.0' : '4.0.0' }],
              },
            ],
          },
        ],
        references: [],
      }),
    );
  }
  if (u.hostname === 'www.cisa.gov')
    return Promise.resolve(Response.json({ vulnerabilities: [{ cveID: 'CVE-2020-1111' }] }));
  if (u.hostname === 'api.first.org')
    return Promise.resolve(
      Response.json({
        data:
          u.searchParams
            .get('cve')
            ?.split(',')
            .map((cve) => ({ cve, epss: '0.25', percentile: '0.88' })) ?? [],
      }),
    );
  if (u.hostname === 'registry.npmjs.org')
    return Promise.resolve(
      Response.json({
        'dist-tags': { latest: '2.0.0' },
        versions: {
          '1.0.0': { dependencies: { shared: '^3.0.0' } },
          '1.1.0': { dependencies: { shared: '^4.0.0' } },
          '2.0.0': { dependencies: { shared: '^4.0.0' } },
        },
      }),
    );
  throw Error(`Unexpected outbound URL: ${u.origin}${u.pathname}`);
}
export async function setupFixtures() {
  folder = await mkdtemp(path.join(os.tmpdir(), 'scan-test-'));
  const root = path.join(folder, 'test-repo-' + sha('nodegoat'));
  await mkdir(root);
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'test', dependencies: { parent: '^1.0.0', express: '^4.0.0' } }),
  );
  await writeFile(
    path.join(root, 'package-lock.json'),
    await readFile(new URL('../fixtures/v3-package-lock.json', import.meta.url)),
  );
  const file = path.join(folder, 'fixture.tar');
  await tar.c({ cwd: folder, file }, [path.basename(root)]);
  archive = await readFile(file);
  const mono = path.join(folder, 'test-repo-' + sha('monorepo'));
  await mkdir(path.join(mono, 'packages/web'), { recursive: true });
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { parent: '^1.0.0' } },
      'node_modules/parent': { version: '1.0.0' },
    },
  });
  for (const dir of [mono, path.join(mono, 'packages/web')]) {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { parent: '^1.0.0' } }),
    );
    await writeFile(path.join(dir, 'package-lock.json'), lock);
  }
  const monoFile = path.join(folder, 'monorepo.tar');
  await tar.c({ cwd: folder, file: monoFile }, [path.basename(mono)]);
  monorepoArchive = await readFile(monoFile);
  const empty = path.join(folder, 'test-repo-' + sha('is'));
  await mkdir(empty);
  await writeFile(path.join(empty, 'README.md'), 'no lockfile');
  const file2 = path.join(folder, 'empty.tar');
  await tar.c({ cwd: folder, file: file2 }, [path.basename(empty)]);
  withoutLock = await readFile(file2);
  globalThis.fetch = stub;
}
export async function cleanupFixtures() {
  globalThis.fetch = realFetch;
  await rm(folder, { recursive: true, force: true });
}
