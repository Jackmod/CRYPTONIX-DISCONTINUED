import type { HeliusEnhancedTransaction, ParsedSwap } from './types.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Turns one Helius enhanced transaction into a SOL-denominated swap.
 *
 * KNOWN LIMITATION — token-to-token swaps.
 *
 * The side is decided by which way the TOKEN moved, and the amount by the
 * native SOL that moved with it. A swap of one SPL token straight into
 * another therefore records as a buy of the incoming token with `solAmount: 0`,
 * because no lamports left the wallet. FIFO then holds a lot with a zero cost
 * basis, and selling it later reports the entire proceeds as profit.
 *
 * The obvious fix — refusing to record a buy that cost no SOL — is NOT safe
 * without real Helius data to check it against. A genuine SOL purchase routed
 * through wrapped SOL can also show no native transfer attributed to the
 * wallet, and dropping those would lose real trades: a worse failure than
 * overstating one position, and a silent one.
 *
 * So this is left as it is, deliberately, until there is live delivery data to
 * distinguish the two cases. On the memecoin trades this tracker exists for,
 * nearly every swap is SOL-paired.
 */
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
