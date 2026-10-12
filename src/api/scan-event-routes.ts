import { constants as HTTP } from 'node:http2';
import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import type { ServerResponse } from 'node:http';
import { listen, eventsAfter, eventStatus } from '../db/scan-event-store.ts';
import { snapshot } from '../scans/scan-queries.ts';
import { ScanError } from '../errors.ts';
import { scanId, eventsQuery } from './scan-request-schemas.ts';

const SSE_RETRY_MS = 2_000;
// Proxies close idle streams.
const SSE_PING_INTERVAL_MS = 15_000;
// Backfill when LISTEN misses a wakeup.
const SSE_FALLBACK_POLL_INTERVAL_MS = 5_000;

/**
 * SSE progress stream per scan: LISTEN-driven push, a 5s poll as backfill, 15s pings,
 * and Last-Event-ID replay. `sending`/`again` make send() single-flight — concurrent
 * wakeups just request another lap. The stream ends only at a terminal status with every
 * event delivered, so clients never miss the last row.
 */
export const eventsRoutes: FastifyPluginAsyncZod = async (app) => {
  // Per-scan wakeup callbacks, fanned out from the shared LISTEN connection.
  const subscribers = new Map<string, Set<() => void>>();
  const connections = new Set<ServerResponse>();
  const stopListener = listen(
    'scan_events',
    (payload) => {
      if (payload) for (const cb of subscribers.get(payload) ?? []) cb();
    },
    () => {
      for (const callbacks of subscribers.values()) for (const cb of callbacks) cb();
    },
  );

  app.addHook('preClose', async () => {
    stopListener();
    for (const response of connections) response.end();
    connections.clear();
  });

  app.get(
    '/api/scans/:id/events',
    { schema: { params: scanId, querystring: eventsQuery } },
    async (req, reply) => {
      const { id } = req.params;
      await snapshot(id);
      let last = Number(req.headers['last-event-id'] ?? req.query.lastEventId ?? 0);
      if (!Number.isSafeInteger(last) || last < 0)
        throw new ScanError(
          'INVALID_EVENT_ID',
          'Invalid Last-Event-ID',
          false,
          HTTP.HTTP_STATUS_BAD_REQUEST,
        );
      reply.hijack();
      const res = reply.raw;
      connections.add(res);
      res.writeHead(HTTP.HTTP_STATUS_OK, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      // 2s reconnect hint for browser EventSource; pings keep proxies from idling out.
      res.write(`retry: ${SSE_RETRY_MS}\n\n`);
      let closed = false,
        sending = false,
        again = false;
      const set = subscribers.get(id) ?? new Set<() => void>();
      subscribers.set(id, set);
      const ping = setInterval(() => {
        if (!closed) res.write(': ping\n\n');
      }, SSE_PING_INTERVAL_MS);
      const poll = setInterval(() => {
        void send();
      }, SSE_FALLBACK_POLL_INTERVAL_MS);
      const cleanup = () => {
        if (closed) return;
        closed = true;
        connections.delete(res);
        clearInterval(ping);
        clearInterval(poll);
        set.delete(send);
        if (!set.size) subscribers.delete(id);
      };
      res.on('close', cleanup);
      const send = async () => {
        if (closed) return;
        // Single-flight: a wakeup during a send just requests one more lap.
        if (sending) {
          again = true;
          return;
        }
        sending = true;
        try {
          do {
            again = false;
            const rows = await eventsAfter(id, last);
            if (closed) return;
            for (const event of rows) {
              res.write(`id: ${event.seq}\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`);
              last = event.seq;
            }
            const status = await eventStatus(id);
            if (closed) return;
            // Terminal only after every event is on the wire — clients see the full log.
            if (
              status &&
              ['completed', 'failed', 'cancelled'].includes(status.status) &&
              last >= status.eventSeq
            ) {
              res.write(`event: end\ndata: ${JSON.stringify({ status: status.status })}\n\n`);
              res.end();
              cleanup();
              return;
            }
          } while (again);
        } catch {
          res.end();
          cleanup();
        } finally {
          sending = false;
        }
      };
      set.add(send);
      await send();
    },
  );
};
