import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { downloadSnapshot } from '../../src/integrations/github-repository.ts';
function replaceName(buffer: Buffer, from: string, to: string) {
  for (let at = 0; at < buffer.length;) {
    const block = buffer.subarray(at, at + 512);
    const name = block.toString('utf8', 0, 100).split('\0')[0];
    if (!name) break;
    const size = parseInt(block.toString('ascii', 124, 136).replace(/\0|\s/g, ''), 8) || 0;
    if (name === from) {
      block.fill(0, 0, 100);
      block.write(to, 0, 'utf8');
      block.fill(32, 148, 156);
      let sum = 0;
      for (const byte of block) sum += byte;
      block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
}
const exists = async (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
test('tar extraction strips top folder; rejects traversal, absolute, links, large files; lockfiles up to 20 MB survive', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'snapshot-'));
  const folder = 'owner-repo-' + 'a'.repeat(40),
    base = path.join(root, folder),
    dest = path.join(root, 'out');
  await mkdir(base);
  await mkdir(dest);
  await writeFile(path.join(base, 'normal.txt'), 'okay');
  await writeFile(path.join(base, 'large.txt'), Buffer.alloc(5 * 1024 * 1024 + 1));
  await writeFile(path.join(base, 'package-lock.json'), Buffer.alloc(5 * 1024 * 1024 + 1));
  await mkdir(path.join(base, 'nested'));
  await writeFile(
    path.join(base, 'nested', 'package-lock.json'),
    Buffer.alloc(20 * 1024 * 1024 + 1),
  );
  await writeFile(path.join(base, 'traversal.txt'), 'unsafe');
  await writeFile(path.join(base, 'absolute.txt'), 'unsafe');
  await symlink('normal.txt', path.join(base, 'link'));
  const archive = path.join(root, 'archive.tar');
  try {
    await tar.c({ cwd: root, file: archive }, [folder]);
    const bytes = await readFile(archive);
    replaceName(bytes, `${folder}/traversal.txt`, '../escape.txt');
    replaceName(bytes, `${folder}/absolute.txt`, path.join(root, 'absolute.out'));
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = async () => new Response(bytes, { status: 200 });
    try {
      const result = await downloadSnapshot(
        'owner',
        'repo',
        'a'.repeat(40),
        dest,
        new AbortController().signal,
      );
      assert.equal(await readFile(path.join(dest, 'normal.txt'), 'utf8'), 'okay');
      assert.equal(await exists(path.join(dest, 'large.txt')), false);
      assert.equal(await exists(path.join(dest, 'link')), false);
      assert.equal(await exists(path.join(root, 'escape.txt')), false);
      assert.equal(await exists(path.join(root, 'absolute.out')), false);
      assert.equal(await exists(path.join(dest, 'package-lock.json')), true);
      assert.equal(await exists(path.join(dest, 'nested', 'package-lock.json')), false);
      assert.deepEqual(result.skipped.lockfiles, ['nested/package-lock.json']);
      assert.ok(result.skipped.symlinks >= 1);
      assert.ok(result.skipped.largeFiles >= 2);
    } finally {
      globalThis.fetch = fetchBefore;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
