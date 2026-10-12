import { constants as HTTP } from 'node:http2';
import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import { db } from '../db/database-client.ts';
import { sql } from 'drizzle-orm';
import { metrics } from '../scans/scan-queries.ts';

/** Liveness (DB check) and queue metrics. */
export const systemRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/healthz', async (_req, reply) => {
    try {
      await db.execute(sql`SELECT 1`);
      return { ok: true, db: true };
    } catch {
      return reply.code(HTTP.HTTP_STATUS_SERVICE_UNAVAILABLE).send({ ok: false, db: false });
    }
  });

  app.get('/api/metrics', async () => metrics());
};
