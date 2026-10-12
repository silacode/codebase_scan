import { sql, eq, and, gt, asc } from 'drizzle-orm';
import { pool, db } from './database-client.ts';
import type { Transaction } from './database-client.ts';
import { scanEvents, scans } from './schema.ts';
import { log } from '../logger.ts';

/**
 * Append a scan event: one statement bumps event_seq (guarded to the current running
 * attempt, or unguarded when attempt is null), inserts the event, and pg_notify's the SSE
 * channel — atomically. Returns false when the guard matched nothing, i.e. ownership was
 * lost; callers treat that as "this attempt no longer owns the scan".
 */
export async function emitEvent(
  client: Transaction,
  scanId: string,
  attempt: number | null,
  stage: string,
  level: 'info' | 'warn' | 'error',
  message: string,
) {
  const result = await client.execute(sql`WITH bumped AS (
    UPDATE scans SET event_seq=event_seq+1 WHERE id=${scanId} AND (${attempt}::int IS NULL OR (attempt=${attempt} AND status='running')) RETURNING id,event_seq
  ), inserted AS (
    INSERT INTO scan_events(scan_id,seq,stage,level,message) SELECT id,event_seq,${stage},${level},${message} FROM bumped RETURNING scan_id
  ) SELECT pg_notify('scan_events',scan_id::text) FROM inserted`);
  return result.rows.length === 1;
}
/** Events with seq > last, in order — the SSE replay/backfill query. */
export const eventsAfter = (id: string, last: number) =>
  db
    .select({
      seq: scanEvents.seq,
      at: scanEvents.at,
      stage: scanEvents.stage,
      level: scanEvents.level,
      message: scanEvents.message,
    })
    .from(scanEvents)
    .where(and(eq(scanEvents.scanId, id), gt(scanEvents.seq, last)))
    .orderBy(asc(scanEvents.seq));
/** The scan's status and latest event_seq, so SSE can decide when to end the stream. */
export const eventStatus = async (id: string) =>
  (
    await db
      .select({ status: scans.status, eventSeq: scans.eventSeq })
      .from(scans)
      .where(eq(scans.id, id))
  )[0];

// No tight reconnect loop.
const LISTENER_INITIAL_RECONNECT_DELAY_MS = 1_000;
// Resume promptly after recovery.
const LISTENER_MAX_RECONNECT_DELAY_MS = 10_000;

/**
 * A dedicated pg client LISTENing on `channel`, with reconnect + exponential backoff
 * (1s doubling to 10s). `broken`/`close` make teardown idempotent and let stop() sever the
 * exact live client even after a reconnect replaced it. The returned function stops the
 * loop and releases the client; notifications fan out to per-scan callbacks.
 */
export function listen(
  channel: 'scan_events',
  notify: (payload?: string) => void,
  ready: () => void = () => {},
) {
  let close: (() => void) | undefined;
  let stopped = false;
  let delay = LISTENER_INITIAL_RECONNECT_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function connect() {
    timer = undefined;
    if (stopped) return;
    let next: import('pg').PoolClient | undefined;
    try {
      next = await pool.connect();
      if (stopped) {
        next.release(true);
        return;
      }
      // `broken`/`close` make release() idempotent and pin teardown to this exact client.
      let broken = false;
      const release = () => {
        if (broken) return;
        broken = true;
        const dead = next;
        next = undefined;
        if (close === release) close = undefined;
        dead?.release(true);
      };
      close = release;
      const fail = (error: Error) => {
        if (broken) return;
        log('error', 'Postgres listener disconnected', { channel, error: error.message });
        release();
        if (!stopped) {
          timer = setTimeout(() => void connect(), delay);
          delay = Math.min(delay * 2, LISTENER_MAX_RECONNECT_DELAY_MS);
        }
      };
      next.on('error', fail);
      next.on('end', () => fail(new Error('Connection ended')));
      next.on('notification', (notification) => notify(notification.payload));
      await next.query(`LISTEN ${channel}`);
      if (broken || stopped) {
        if (stopped) release();
        return;
      }
      delay = LISTENER_INITIAL_RECONNECT_DELAY_MS;
      ready();
    } catch (error) {
      close?.();
      if (!stopped && !timer) {
        log('error', 'Postgres listener setup failed', {
          channel,
          error: error instanceof Error ? error.message : 'unknown',
        });
        timer = setTimeout(() => void connect(), delay);
        delay = Math.min(delay * 2, LISTENER_MAX_RECONNECT_DELAY_MS);
      }
    }
  }
  void connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    close?.();
  };
}
