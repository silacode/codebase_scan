import { and, eq, gt, sql } from 'drizzle-orm';
import { db } from './database-client.ts';
import { cache } from './schema.ts';

/** Cached value for `key`, or undefined when missing/expired (expired rows are ignored). */
export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const row = await db
    .select({ value: cache.value })
    .from(cache)
    .where(and(eq(cache.key, key), gt(cache.expiresAt, sql`now()`)));
  return row[0]?.value as T | undefined;
}
/** Upsert `value` at `key` with a `ttlMs` expiry. */
export async function cacheSet(key: string, value: unknown, ttlMs: number) {
  await db
    .insert(cache)
    .values({ key, value, expiresAt: sql`now()+(${ttlMs} * interval '1 millisecond')` })
    .onConflictDoUpdate({ target: cache.key, set: { value, expiresAt: sql`excluded.expires_at` } });
}
