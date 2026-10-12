import { z } from 'zod';
import { repoUrlSchema } from '../contracts/repo-url.ts';

// Fastify route schemas (Zod): validated and typed request parts.

/** The :id path param — a UUID. */
export const scanId = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/),
});

/** POST /api/scans body. */
export const submitBody = z.object({
  repoUrl: repoUrlSchema,
  ref: z.string().optional(),
  force: z.boolean().optional(),
});

/** GET /findings filters (strings; the route parses/validates numbers). */
export const findingsQuery = z.object({
  offset: z.string().optional(),
  limit: z.string().optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  dev: z.enum(['true', 'false']).optional(),
  direct: z.enum(['true', 'false']).optional(),
});
/** SSE replay cursor (Last-Event-ID header or query fallback). */
export const eventsQuery = z.object({ lastEventId: z.string().optional() });
