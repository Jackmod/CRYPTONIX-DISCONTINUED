import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, wallets } from './index';

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cryptonix_test';
const db = createDb(TEST_DB_URL);

describe('wallets table', () => {
  beforeEach(async () => {
    await db.execute('TRUNCATE wallets CASCADE');
  });

  it('inserts and reads back a wallet', async () => {
    const [inserted] = await db.insert(wallets).values({ address: 'Addr1', label: 'Test' }).returning();
    expect(inserted.id).toBeDefined();
    expect(inserted.isMine).toBe(false);

    const rows = await db.select().from(wallets);
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe('Addr1');
  });
});
