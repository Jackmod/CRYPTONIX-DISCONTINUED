import { describe, it, expect, vi } from 'vitest';
import { DexScreenerClient } from './dexscreener';

/** No real waiting: rate-limit spacing and retry backoff resolve immediately. */
const instantClock = { now: () => Date.now(), sleep: async () => {} };

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, body: null } as unknown as Response;
}

function client(fetchImpl: ReturnType<typeof vi.fn>) {
  return new DexScreenerClient({ fetchImpl: fetchImpl as unknown as typeof fetch, clock: instantClock });
}

describe('listRecentSolanaMints', () => {
  it('returns Solana mints and drops other chains', () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        { chainId: 'solana', tokenAddress: 'SolMint1' },
        { chainId: 'ethereum', tokenAddress: '0xabc' },
        { chainId: 'solana', tokenAddress: 'SolMint2' },
      ])
    );

    return client(fetchImpl)
      .listRecentSolanaMints()
      .then((mints) => {
        expect(mints).toEqual(['SolMint1', 'SolMint2']);
      });
  });

  it('survives a response that is not the array it expects', async () => {
    // A third party we do not control can change shape at any time; the
    // scanner must degrade to "nothing new" rather than throwing.
    for (const body of [null, {}, 'text', 42]) {
      const mints = await client(vi.fn(async () => jsonResponse(body))).listRecentSolanaMints();
      expect(mints, `body ${JSON.stringify(body)}`).toEqual([]);
    }
  });

  it('ignores entries missing a token address', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([{ chainId: 'solana' }, { chainId: 'solana', tokenAddress: 'Good' }])
    );

    expect(await client(fetchImpl).listRecentSolanaMints()).toEqual(['Good']);
  });
});

describe('getSnapshot', () => {
  const pair = {
    chainId: 'solana',
    pairCreatedAt: Date.now() - 3 * 60_000,
    baseToken: { address: 'Mint1', symbol: 'catcall' },
    liquidity: { usd: 40_000 },
    volume: { m5: 24_983, h1: 24_983 },
    priceChange: { m5: 79.97 },
    txns: { m5: { buys: 288, sells: 157 } },
    fdv: 500_000,
  };

  it('normalises a pair into a snapshot', async () => {
    const snapshot = await client(vi.fn(async () => jsonResponse({ pairs: [pair] }))).getSnapshot('Mint1');

    expect(snapshot).not.toBeNull();
    expect(snapshot!.symbol).toBe('catcall');
    expect(snapshot!.ageMinutes).toBeGreaterThan(2.5);
    expect(snapshot!.ageMinutes).toBeLessThan(4);
    expect(snapshot!.buys5m).toBe(288);
    expect(snapshot!.liquidityUsd).toBe(40_000);
  });

  it('reports missing liquidity as null, never as zero', async () => {
    // The newest pairs often carry no liquidity figure. Zero would read as
    // "no liquidity" and the momentum gate would reject exactly the coins the
    // scanner exists to find.
    const withoutLiquidity = { ...pair, liquidity: undefined };

    const snapshot = await client(vi.fn(async () => jsonResponse({ pairs: [withoutLiquidity] }))).getSnapshot('Mint1');

    expect(snapshot!.liquidityUsd).toBeNull();
  });

  it('picks the most liquid pair when a token trades on several DEXes', async () => {
    const thin = { ...pair, liquidity: { usd: 1_000 }, baseToken: { address: 'Mint1', symbol: 'thin' } };
    const deep = { ...pair, liquidity: { usd: 90_000 }, baseToken: { address: 'Mint1', symbol: 'deep' } };

    const snapshot = await client(vi.fn(async () => jsonResponse({ pairs: [thin, deep] }))).getSnapshot('Mint1');

    expect(snapshot!.symbol).toBe('deep');
  });

  it('does not let a pair with unknown liquidity outrank a known deep one', async () => {
    const unknown = { ...pair, liquidity: undefined, baseToken: { address: 'Mint1', symbol: 'unknown' } };
    const deep = { ...pair, liquidity: { usd: 90_000 }, baseToken: { address: 'Mint1', symbol: 'deep' } };

    const snapshot = await client(vi.fn(async () => jsonResponse({ pairs: [unknown, deep] }))).getSnapshot('Mint1');

    expect(snapshot!.symbol).toBe('deep');
  });

  it('returns null when the token has no Solana pair', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ pairs: [{ ...pair, chainId: 'ethereum' }] }));

    expect(await client(fetchImpl).getSnapshot('Mint1')).toBeNull();
  });

  it('returns null rather than throwing on an empty or malformed body', async () => {
    for (const body of [{}, { pairs: [] }, { pairs: [{ chainId: 'solana' }] }]) {
      expect(await client(vi.fn(async () => jsonResponse(body))).getSnapshot('Mint1')).toBeNull();
    }
  });

  it('treats a pair with no creation time as infinitely old', async () => {
    // Unknown age must not read as "brand new" and slip past the age gate.
    const undated = { ...pair, pairCreatedAt: undefined };

    const snapshot = await client(vi.fn(async () => jsonResponse({ pairs: [undated] }))).getSnapshot('Mint1');

    expect(snapshot!.ageMinutes).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('retries', () => {
  it('retries a 429 and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, body: null })
      .mockResolvedValueOnce(jsonResponse([]));

    await client(fetchImpl).listRecentSolanaMints();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry budget and surfaces the status', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, body: null }) as unknown as Response);

    const error = await client(fetchImpl).listRecentSolanaMints().catch((e) => e);

    expect(error.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it('does not retry a 4xx that is not a rate limit', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, body: null }) as unknown as Response);

    await expect(client(fetchImpl).getSnapshot('Mint1')).rejects.toThrow('DexScreener');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('getSnapshot: the requested mint must be the base token', () => {
  const pair = (baseAddress: string, symbol: string, liquidityUsd: number) => ({
    chainId: 'solana',
    pairCreatedAt: Date.now() - 60_000,
    baseToken: { address: baseAddress, symbol },
    liquidity: { usd: liquidityUsd },
    volume: { m5: 1000, h1: 1000 },
    priceChange: { m5: 5 },
    txns: { m5: { buys: 10, sells: 5 } },
    fdv: 1000,
  });

  it('ignores a more liquid pair where the requested mint is not the base', async () => {
    // The endpoint returns pairs where the token is base OR quote. Taking the
    // most liquid regardless named the WRONG coin in the alert and filed the
    // dedupe row under a mint the next poll never looks up -- so the same
    // alert republished every minute, forever. Every earlier test used
    // matching mints, so none of them could catch it.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        pairs: [
          pair('SomeOtherToken', 'OTHER', 900_000), // far more liquid, wrong base
          pair('Wanted', 'WANTED', 1_000),
        ],
      })
    );

    const snapshot = await client(fetchImpl).getSnapshot('Wanted');

    expect(snapshot!.mint).toBe('Wanted');
    expect(snapshot!.symbol).toBe('WANTED');
  });

  it('returns null when the mint only ever appears as a quote token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ pairs: [pair('SomeOtherToken', 'OTHER', 900_000)] }));

    expect(await client(fetchImpl).getSnapshot('Wanted')).toBeNull();
  });

  it('still picks the most liquid pair among those with the right base', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        pairs: [pair('Wanted', 'thin', 1_000), pair('Wanted', 'deep', 90_000), pair('Other', 'x', 999_999)],
      })
    );

    const snapshot = await client(fetchImpl).getSnapshot('Wanted');

    expect(snapshot!.symbol).toBe('deep');
  });
});
