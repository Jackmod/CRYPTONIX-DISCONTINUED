import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  // An idle pooled connection dropping (Neon auto-suspend, a DB restart, a
  // proxy reaping idle conns) emits 'error' on the pool. With no listener,
  // Node rethrows it as an uncaught exception and the engine dies.
  pool.on('error', (err) => {
    console.error('postgres pool error (connection will be re-established on next query)', err);
  });
  return drizzle(pool, { schema });
}

export type Db = NodePgDatabase<typeof schema>;
