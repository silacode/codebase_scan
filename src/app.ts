import Fastify from 'fastify';
import { constants as HTTP } from 'node:http2';
import staticPlugin from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
} from '@fastify/type-provider-zod';
import { MAX_BODY_BYTES } from './config.ts';
import { ScanError } from './errors.ts';
import { log } from './logger.ts';
import { scansRoutes } from './api/scan-routes.ts';
import { eventsRoutes } from './api/scan-event-routes.ts';
import { systemRoutes } from './api/system-routes.ts';

// One client can't take all slots.
const DEFAULT_ACTIVE_SCANS_PER_IP = 3;
// Per-IP burst limit.
const DEFAULT_SUBMISSIONS_PER_MINUTE_PER_IP = 10;
// Backoff hint for throttled clients.
const SUBMISSION_RETRY_AFTER_SECONDS = 10;
// Longer backoff when overloaded.
const OVERLOAD_RETRY_AFTER_SECONDS = 30;

/**
 * Build the Fastify app: JSON-only typed routes, SSE progress, static SPA fallback, and a
 * single error handler that maps everything to the ScanError wire shape.
 */
export async function createApi(
  options: { limits?: { active?: number; submitsPerMinute?: number } } = {},
) {
  const app = Fastify({
    bodyLimit: MAX_BODY_BYTES,
    exposeHeadRoutes: false,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error, _req, reply) => {
    let fault: ScanError;
    if (error instanceof ScanError) fault = error;
    else if (!(error instanceof Error))
      fault = new ScanError('INTERNAL', 'Internal server error', true);
    else if ('code' in error && error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE')
      fault = new ScanError('INVALID_BODY', 'Expected JSON', false, HTTP.HTTP_STATUS_BAD_REQUEST);
    else if ('code' in error && error.code === 'FST_ERR_CTP_BODY_TOO_LARGE')
      fault = new ScanError(
        'BODY_TOO_LARGE',
        `Body exceeds ${MAX_BODY_BYTES / 1024} KB`,
        false,
        HTTP.HTTP_STATUS_PAYLOAD_TOO_LARGE,
      );
    else if (
      'code' in error &&
      (error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
        error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY')
    )
      fault = new ScanError('INVALID_BODY', 'Invalid JSON', false, HTTP.HTTP_STATUS_BAD_REQUEST);
    else if (hasZodFastifySchemaValidationErrors(error)) {
      const context = error.validationContext;
      if (context === 'params')
        fault = new ScanError('INVALID_ID', 'Invalid scan ID', false, HTTP.HTTP_STATUS_BAD_REQUEST);
      else if (context === 'querystring')
        fault = new ScanError(
          'INVALID_FILTER',
          'Invalid filter',
          false,
          HTTP.HTTP_STATUS_BAD_REQUEST,
        );
      else
        fault = new ScanError(
          'INVALID_URL',
          'Invalid scan request',
          false,
          HTTP.HTTP_STATUS_BAD_REQUEST,
        );
    } else {
      log('error', 'API request failed', { error: error.message });
      fault = new ScanError('INTERNAL', 'Internal server error', true);
    }
    if (fault.status === HTTP.HTTP_STATUS_TOO_MANY_REQUESTS || fault.code === 'OVERLOADED')
      reply.header(
        'retry-after',
        String(
          fault.code === 'OVERLOADED'
            ? OVERLOAD_RETRY_AFTER_SECONDS
            : SUBMISSION_RETRY_AFTER_SECONDS,
        ),
      );
    return reply
      .code(fault.status)
      .send({ error: { code: fault.code, message: fault.message, retryable: fault.retryable } });
  });
  await app.register(
    scansRoutes({
      active: options.limits?.active ?? DEFAULT_ACTIVE_SCANS_PER_IP,
      submitsPerMinute: options.limits?.submitsPerMinute ?? DEFAULT_SUBMISSIONS_PER_MINUTE_PER_IP,
    }),
  );
  await app.register(eventsRoutes);
  await app.register(systemRoutes);
  const dist = path.resolve(fileURLToPath(new URL('../web/dist/', import.meta.url)));
  await app.register(staticPlugin, { root: dist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    const rawPath = req.url.split('?')[0];
    let pathname = '';
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      // Malformed path encoding is not application navigation.
    }
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      pathname &&
      !pathname.startsWith('/api/') &&
      !pathname.split('/').some((segment) => segment.startsWith('.')) &&
      !path.posix.extname(pathname)
    )
      return reply.sendFile('index.html');
    return reply.code(HTTP.HTTP_STATUS_NOT_FOUND).send({
      error: {
        code: 'NOT_FOUND',
        message: rawPath.startsWith('/api/') ? 'Route not found' : 'Asset not found',
        retryable: false,
      },
    });
  });
  return app;
}
