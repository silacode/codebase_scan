import { constants as HTTP } from 'node:http2';
import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import { ScanError } from '../errors.ts';
import { scanService, cancel } from '../scans/scan-service.ts';
import { snapshot, listFindings, listIssues } from '../scans/scan-queries.ts';
import { scanId, submitBody, findingsQuery } from './scan-request-schemas.ts';

const DEFAULT_FINDINGS_PAGE_SIZE = 50;
const MAX_FINDINGS_PAGE_SIZE = 100;

/** A single idempotency key; repeated headers fail validation as an empty key. */
function idempotencyKey(header: string | string[] | undefined) {
  if (header === undefined) return undefined;
  return typeof header === 'string' ? header : '';
}

/** Scan lifecycle routes: submit (idempotent), get, findings, issues, cancel. */
export function scansRoutes(limits: {
  active: number;
  submitsPerMinute: number;
}): FastifyPluginAsyncZod {
  const service = scanService(limits);
  return async (app) => {
    app.post(
      '/api/scans',
      {
        schema: { body: submitBody },
        onRequest: async (req) => {
          if (!req.headers['content-type']?.toLowerCase().startsWith('application/json'))
            throw new ScanError(
              'INVALID_BODY',
              'Expected JSON',
              false,
              HTTP.HTTP_STATUS_BAD_REQUEST,
            );
        },
        preValidation: async (req) => {
          if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
            throw new ScanError(
              'INVALID_BODY',
              'Expected a JSON object',
              false,
              HTTP.HTTP_STATUS_BAD_REQUEST,
            );
        },
      },
      async (req, reply) => {
        const result = await service.submit(
          req.body,
          idempotencyKey(req.headers['idempotency-key']),
          req.ip,
        );
        return reply
          .code(result.status)
          .header('location', `/api/scans/${result.id}`)
          .send(result.data);
      },
    );

    app.get('/api/scans/:id', { schema: { params: scanId } }, async (req) =>
      snapshot(req.params.id),
    );

    app.get(
      '/api/scans/:id/findings',
      { schema: { params: scanId, querystring: findingsQuery } },
      async (req) => {
        const offset = Math.max(0, Number(req.query.offset ?? 0));
        const limit = Math.min(
          MAX_FINDINGS_PAGE_SIZE,
          Math.max(1, Number(req.query.limit ?? DEFAULT_FINDINGS_PAGE_SIZE)),
        );
        if (!Number.isInteger(offset) || !Number.isInteger(limit))
          throw new ScanError(
            'INVALID_FILTER',
            'Invalid pagination',
            false,
            HTTP.HTTP_STATUS_BAD_REQUEST,
          );
        return listFindings(
          req.params.id,
          offset,
          limit,
          req.query.severity,
          req.query.dev,
          req.query.direct,
        );
      },
    );

    app.get('/api/scans/:id/issues', { schema: { params: scanId } }, async (req) =>
      listIssues(req.params.id),
    );

    app.post('/api/scans/:id/cancel', { schema: { params: scanId } }, async (req, reply) =>
      reply.code(HTTP.HTTP_STATUS_ACCEPTED).send(await cancel(req.params.id)),
    );
  };
}
