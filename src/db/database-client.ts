import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { config } from '../config.ts';
import { log } from '../logger.ts';
import * as schema from './schema.ts';

// One shared pool for the API and worker processes.
export const pool = new pg.Pool({ connectionString: config.databaseUrl });
pool.on('error', (error) =>
  log('error', 'Idle Postgres connection lost', { error: error.message }),
);
export const db = drizzle({ client: pool, schema });
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Run `fn` in a transaction; all fencing/claim logic goes through here. */
export const tx = <T>(fn: (client: Transaction) => Promise<T>) => db.transaction(fn);
