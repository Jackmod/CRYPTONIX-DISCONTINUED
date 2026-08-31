import { describe, it, expect } from 'vitest';
import { parseSwap } from './parse-swap';
import type { HeliusEnhancedTransaction } from './types';

const WALLET = 'WalletAddr111';
const OTHER = 'PoolAddr222';
const MINT = 'TokenMint333';

function tx(overrides: Partial<HeliusEnhancedTransaction> = {}): HeliusEnhancedTransaction {
  return {
    signature: 'sig1',
    timestamp: 1_735_000_000,
    type: 'SWAP',
    tokenTransfers: [],
    nativeTransfers: [],
    ...overrides,
  };
}

describe('parseSwap', () => {
  it('parses a buy: wallet receives token, pays SOL', () => {
    const result = parseSwap(
      tx({
        tokenTransfers: [{ fromUserAccount: OTHER, toUserAccount: WALLET, mint: MINT, tokenAmount: 1000 }],
        nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: OTHER, amount: 2_000_000_000 }],
      }),
      WALLET
    );
    expect(result).toEqual({
      signature: 'sig1',
      ts: new Date(1_735_000_000 * 1000),
      mint: MINT,
      side: 'buy',
      solAmount: 2,
      tokenAmount: 1000,
    });
  });

  it('parses a sell: wallet sends token, receives SOL', () => {
    const result = parseSwap(
      tx({
        tokenTransfers: [{ fromUserAccount: WALLET, toUserAccount: OTHER, mint: MINT, tokenAmount: 500 }],
        nativeTransfers: [{ fromUserAccount: OTHER, toUserAccount: WALLET, amount: 1_500_000_000 }],
      }),
      WALLET
    );
    expect(result).toEqual({
      signature: 'sig1',
      ts: new Date(1_735_000_000 * 1000),
      mint: MINT,
      side: 'sell',
      solAmount: 1.5,
      tokenAmount: 500,
    });
  });

  it('returns null when the wallet is not involved in any token transfer', () => {
    const result = parseSwap(
      tx({
        tokenTransfers: [{ fromUserAccount: OTHER, toUserAccount: 'SomeoneElse', mint: MINT, tokenAmount: 10 }],
      }),
      WALLET
    );
    expect(result).toBeNull();
  });
});
