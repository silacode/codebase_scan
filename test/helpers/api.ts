import { beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import './database.ts';
import { setupFixtures, cleanupFixtures } from './fixtures.ts';

export let server: FastifyInstance;
export let base: string;
export async function open(options?: { limits: { active: number; submitsPerMinute: number } }) {
  const { createApi } = await import('../../src/app.ts');
  const app = await createApi(options);
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, url };
}
export const close = (app: FastifyInstance) => app.close();
export async function post(repo: string, key: string, service = base) {
  const response = await fetch(`${service}/api/scans`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ repoUrl: `https://github.com/test/${repo}` }),
  });
  return { status: response.status, body: await response.json() };
}
beforeAll(async () => {
  await setupFixtures();
  const opened = await open({ limits: { active: 100, submitsPerMinute: 100 } });
  server = opened.app;
  base = opened.url;
});
afterAll(async () => {
  await close(server);
  await cleanupFixtures();
});
