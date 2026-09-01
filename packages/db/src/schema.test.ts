import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, wallets, discordGuilds } from './index';

// Each package owns a separate test database. Turbo runs package test tasks
// in parallel, and these suites TRUNCATE overlapping tables — sharing one
// database lets one package's TRUNCATE delete another's rows mid-test.
const TEST_DB_URL =
  process.env.TEST_DATABASE_URL_DB ?? 'postgres://postgres:postgres@localhost:5432/cryptonix_test_db';
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

describe('discord_guilds table', () => {
  beforeEach(async () => {
    await db.execute('TRUNCATE discord_guilds CASCADE');
  });

  it('inserts and reads back a guild config', async () => {
    const [inserted] = await db
      .insert(discordGuilds)
      .values({ guildId: 'guild1', alertChannelId: 'channel1', setupBy: 'user1' })
      .returning();

    expect(inserted.guildId).toBe('guild1');
    expect(inserted.setupAt).toBeInstanceOf(Date);
  });

  it('upserts on conflict so re-running /setup moves the channel', async () => {
    // /setup is expected to be run more than once - a server changing its mind
    // about which channel gets alerts must not hit a primary key violation.
    await db.insert(discordGuilds).values({ guildId: 'guild1', alertChannelId: 'channel1' });
    await db
      .insert(discordGuilds)
      .values({ guildId: 'guild1', alertChannelId: 'channel2' })
      .onConflictDoUpdate({ target: discordGuilds.guildId, set: { alertChannelId: 'channel2' } });

    const rows = await db.select().from(discordGuilds);
    expect(rows).toHaveLength(1);
    expect(rows[0].alertChannelId).toBe('channel2');
  });
});
