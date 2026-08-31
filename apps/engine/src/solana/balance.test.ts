import { describe, it, expect, vi } from 'vitest';
import { Connection } from '@solana/web3.js';
import { SolanaRpcClient } from './balance';

describe('SolanaRpcClient', () => {
  it('converts a lamports balance to SOL', async () => {
    vi.spyOn(Connection.prototype, 'getBalance').mockResolvedValue(2_500_000_000);
    const client = new SolanaRpcClient('https://example.com/rpc');

    const sol = await client.getBalanceSol('11111111111111111111111111111111');

    expect(sol).toBe(2.5);
  });

  it('does not leak the RPC URL (and its embedded Helius api key) when the RPC call fails', async () => {
    // Regression guard: web3.js's Connection embeds the full request URL --
    // including our Helius api key as a query param -- into the error
    // message it throws on failure. server.ts's asyncRoute logs the whole
    // error object on any route failure, so an unwrapped rethrow would write
    // the key to stdout on every RPC timeout. Assert the key never survives
    // into the thrown error.
    const apiKey = 'super-secret-helius-key';
    vi.spyOn(Connection.prototype, 'getBalance').mockRejectedValue(
      new Error(`failed to get balance of account 1111: TypeError: fetch failed https://example.com/rpc?api-key=${apiKey}`)
    );
    const client = new SolanaRpcClient(`https://example.com/rpc?api-key=${apiKey}`);

    await expect(client.getBalanceSol('11111111111111111111111111111111')).rejects.toThrow();
    try {
      await client.getBalanceSol('11111111111111111111111111111111');
    } catch (err) {
      expect((err as Error).message).not.toContain(apiKey);
    }
  });
});
