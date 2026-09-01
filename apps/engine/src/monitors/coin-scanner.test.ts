import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, scannedCoins, alerts } from '@cryptonix/db';
import { CoinScanner } from './coin-scanner';
import { AlertBus } from '../api/alert-bus';
import type { CoinSnapshot } from '@cryptonix/core';

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cryptonix_test';
const db = createDb(TEST_DB_URL);

/** Clears every gate: modelled on a real pair seen while picking the data source. */
function strongSnapshot(overrides: Partial<CoinSnapshot> = {}): CoinSnapshot {
  return {
    mint: 'Mint1',
    symbol: 'catcall',
    ageMinutes: 3,
    liquidityUsd: 40_000,
    volume5m: 24_983,
    volume1h: 24_983,
    priceChange5m: 79.97,
    buys5m: 288,
    sells5m: 157,
    fdvUsd: 500_000,
    ...overrides,
  };
}

function buildScanner(snapshots: Record<string, CoinSnapshot | null>, mints = Object.keys(snapshots)) {
  const alertBus = new AlertBus();
  const published: unknown[] = [];
  alertBus.on('alert', (a) => published.push(a));

  const dex = {
    listRecentSolanaMints: vi.fn(async () => mints),
    getSnapshot: vi.fn(async (mint: string) => snapshots[mint] ?? null),
  };

  return { scanner: new CoinScanner(db, dex, alertBus), dex, published };
}

describe('CoinScanner', () => {
  beforeEach(async () => {
    await db.execute('TRUNCATE scanned_coins, alerts RESTART IDENTITY CASCADE');
  });

  it('alerts a coin with real momentum', async () => {
    const { scanner, published } = buildScanner({ Mint1: strongSnapshot() });

    expect(await scanner.poll()).toBe(1);

    expect(published).toHaveLength(1);
    const alert = published[0] as { type: string; payload: { symbol: string; axiomLink: string } };
    expect(alert.type).toBe('new_coin');
    expect(alert.payload.symbol).toBe('catcall');
    expect(alert.payload.axiomLink).toBe('https://axiom.trade/t/Mint1');
  });

  it('never alerts the same coin twice, across polls', async () => {
    // The discovery feed returns the same coins every minute, so without this
    // the channel would fill with the same alert forever.
    const { scanner, published } = buildScanner({ Mint1: strongSnapshot() });

    await scanner.poll();
    await scanner.poll();
    await scanner.poll();

    expect(published).toHaveLength(1);
  });

  it('stays quiet about a coin that fails the gates', async () => {
    const { scanner, published } = buildScanner({ Mint1: strongSnapshot({ volume5m: 10 }) });

    expect(await scanner.poll()).toBe(0);
    expect(published).toHaveLength(0);
  });

  it('records a rejected coin so it is not re-scored from scratch forever', async () => {
    const { scanner } = buildScanner({ Mint1: strongSnapshot({ volume5m: 10 }) });

    await scanner.poll();

    const [row] = await db.select().from(scannedCoins);
    expect(row.mint).toBe('Mint1');
    expect(row.alerted).toBe(false);
    expect(row.momentumScore).not.toBeNull();
  });

  it('still alerts a coin that only later builds momentum', async () => {
    // Recording a rejection must not blacklist the coin: plenty launch quiet
    // and move minutes later.
    const snapshots: Record<string, CoinSnapshot> = { Mint1: strongSnapshot({ volume5m: 10 }) };
    const { scanner, published } = buildScanner(snapshots);

    await scanner.poll();
    expect(published).toHaveLength(0);

    snapshots.Mint1 = strongSnapshot(); // momentum arrives
    await scanner.poll();

    expect(published).toHaveLength(1);
  });

  it('writes the alert to the database before publishing it', async () => {
    // The bot's replay recovers alerts published while it was disconnected, so
    // an alert that only ever existed in memory would be lost outright.
    const { scanner } = buildScanner({ Mint1: strongSnapshot() });

    await scanner.poll();

    const rows = await db.select().from(alerts);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('new_coin');
  });

  it('publishes an alert whose id matches its stored row', async () => {
    // Catch-up resumes from that id; a mismatch would skip or repeat alerts.
    const { scanner, published } = buildScanner({ Mint1: strongSnapshot() });

    await scanner.poll();

    const [row] = await db.select().from(alerts);
    expect((published[0] as { id: number }).id).toBe(row.id);
  });

  it('keeps scanning after one coin fails', async () => {
    // Per-coin isolation, the same rule the wallet monitor follows. Injected
    // through the constructor rather than by reaching into a private field,
    // so renaming one cannot quietly turn this into a no-op.
    const alertBus = new AlertBus();
    const published: unknown[] = [];
    alertBus.on('alert', (a) => published.push(a));

    const dex = {
      listRecentSolanaMints: vi.fn(async () => ['Broken', 'Good']),
      getSnapshot: vi.fn(async (mint: string) => {
        if (mint === 'Broken') throw new Error('provider blew up');
        return strongSnapshot({ mint: 'Good' });
      }),
    };
    const scanner = new CoinScanner(db, dex, alertBus);

    expect(await scanner.poll()).toBe(1);
    expect(published).toHaveLength(1);
    expect(dex.getSnapshot).toHaveBeenCalledTimes(2); // it really did try both
  });

  it('ignores a mint with no usable pair', async () => {
    const { scanner, published } = buildScanner({ Mint1: null });

    expect(await scanner.poll()).toBe(0);
    expect(published).toHaveLength(0);
  });

  it('caps how many coins one poll will score', async () => {
    // One sweep must not exhaust the provider's rate limit.
    const snapshots: Record<string, CoinSnapshot> = {};
    const mints = Array.from({ length: 50 }, (_, i) => `Mint${i}`);
    for (const m of mints) snapshots[m] = strongSnapshot({ mint: m, volume5m: 10 });

    const alertBus = new AlertBus();
    const dex = {
      listRecentSolanaMints: vi.fn(async () => mints),
      getSnapshot: vi.fn(async (mint: string) => snapshots[mint] ?? null),
    };
    const scanner = new CoinScanner(db, dex, alertBus, { maxPerPoll: 5 });

    await scanner.poll();

    expect(dex.getSnapshot).toHaveBeenCalledTimes(5);
  });

  it('honours caller-supplied thresholds', async () => {
    // Spec §12 expects these tuned live rather than baked in.
    const alertBus = new AlertBus();
    const published: unknown[] = [];
    alertBus.on('alert', (a) => published.push(a));
    const quiet = strongSnapshot({ volume5m: 200 });
    const dex = {
      listRecentSolanaMints: vi.fn(async () => ['Mint1']),
      getSnapshot: vi.fn(async () => quiet),
    };

    const strict = new CoinScanner(db, dex, alertBus);
    expect(await strict.poll()).toBe(0);

    await db.execute('TRUNCATE scanned_coins, alerts RESTART IDENTITY CASCADE');
    const lenient = new CoinScanner(db, dex, alertBus, {
      thresholds: {
        maxAgeMinutes: 60,
        minVolume5m: 100,
        minBuyRatio: 0.5,
        minPriceChange5m: 10,
        minTrades5m: 10,
        minLiquidityUsd: 1_000,
      },
    });
    expect(await lenient.poll()).toBe(1);
  });
});

describe('CoinScanner: dedupe is durable', () => {
  beforeEach(async () => {
    await db.execute('TRUNCATE scanned_coins, alerts RESTART IDENTITY CASCADE');
  });

  it('never lets a later poll flip an alerted coin back to un-alerted', async () => {
    // The upsert wrote whatever `alerted` the pass computed, so a coin that
    // was alerted and then scored badly went back to false -- and could be
    // alerted all over again.
    const snapshots: Record<string, CoinSnapshot> = { Mint1: strongSnapshot() };
    const { scanner, published } = buildScanner(snapshots);

    await scanner.poll();
    expect(published).toHaveLength(1);

    snapshots.Mint1 = strongSnapshot({ volume5m: 1 }); // now fails the gates
    await scanner.poll();
    await scanner.poll();

    const [row] = await db.select().from(scannedCoins);
    expect(row.alerted).toBe(true); // sticky
    expect(published).toHaveLength(1);
  });

  it('records the coin before the alert goes out', async () => {
    // Publishing first left an alert delivered with no dedupe row if the
    // upsert failed or the process restarted in between, and the next poll
    // alerted the same coin again.
    const alertBus = new AlertBus();
    const seenWhenPublished: boolean[] = [];
    alertBus.on('alert', async () => {
      const rows = await db.select().from(scannedCoins);
      seenWhenPublished.push(rows.length > 0 && rows[0].alerted === true);
    });
    const dex = {
      listRecentSolanaMints: vi.fn(async () => ['Mint1']),
      getSnapshot: vi.fn(async () => strongSnapshot()),
    };

    await new CoinScanner(db, dex, alertBus).poll();
    await new Promise((r) => setTimeout(r, 50));

    expect(seenWhenPublished).toEqual([true]);
  });
});
