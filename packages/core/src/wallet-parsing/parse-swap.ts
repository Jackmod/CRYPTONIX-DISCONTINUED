import type { HeliusEnhancedTransaction, ParsedSwap } from './types.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

export function parseSwap(tx: HeliusEnhancedTransaction, walletAddress: string): ParsedSwap | null {
  const incoming = tx.tokenTransfers.find((t) => t.toUserAccount === walletAddress);
  const outgoing = tx.tokenTransfers.find((t) => t.fromUserAccount === walletAddress);

  const ts = new Date(tx.timestamp * 1000);

  if (incoming) {
    const solPaid = tx.nativeTransfers
      .filter((n) => n.fromUserAccount === walletAddress)
      .reduce((sum, n) => sum + n.amount, 0);
    return {
      signature: tx.signature,
      ts,
      mint: incoming.mint,
      side: 'buy',
      solAmount: solPaid / LAMPORTS_PER_SOL,
      tokenAmount: incoming.tokenAmount,
    };
  }

  if (outgoing) {
    const solReceived = tx.nativeTransfers
      .filter((n) => n.toUserAccount === walletAddress)
      .reduce((sum, n) => sum + n.amount, 0);
    return {
      signature: tx.signature,
      ts,
      mint: outgoing.mint,
      side: 'sell',
      solAmount: solReceived / LAMPORTS_PER_SOL,
      tokenAmount: outgoing.tokenAmount,
    };
  }

  return null;
}

export type { HeliusEnhancedTransaction, HeliusTokenTransfer, HeliusNativeTransfer, ParsedSwap } from './types.js';
