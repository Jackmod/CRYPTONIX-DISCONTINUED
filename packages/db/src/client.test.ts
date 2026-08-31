import { describe, it, expect } from 'vitest';
import { createDb } from './index';

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cryptonix_test';

describe('createDb', () => {
  it('attaches a pool error listener so an idle-connection drop does not crash the process', async () => {
    // Regression guard: pg-pool emits 'error' on the pool for a dropped idle
    // client (this is exactly what happens when Neon auto-suspends). With no
    // listener attached, Node treats that as an uncaught exception and kills
    // the process. drizzle's node-postgres driver exposes the underlying
    // Pool via `$client`, so we can simulate the drop directly without
    // waiting for a real connection to go idle and die.
    const db = createDb(TEST_DB_URL);
    const pool = db.$client;

    expect(pool.listenerCount('error')).toBeGreaterThan(0);

    // If no listener were attached, this emit would throw synchronously
    // (Node's default behavior for an EventEmitter 'error' event with zero
    // listeners) and fail the test instead of being swallowed by our handler.
    expect(() => pool.emit('error', new Error('simulated idle connection drop'))).not.toThrow();

    await pool.end();
  });
});
