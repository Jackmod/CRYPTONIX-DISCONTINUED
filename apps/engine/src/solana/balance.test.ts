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
});
