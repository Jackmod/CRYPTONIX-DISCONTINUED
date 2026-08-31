import type { Db } from '@cryptonix/db';
import { wallets, walletTrades, alerts } from '@cryptonix/db';
import { parseSwap, buildAxiomLink, type HeliusEnhancedTransaction } from '@cryptonix/core';
import type { HeliusClient } from '../helius/client.js';
import type { AlertBus } from '../api/alert-bus.js';

export class WalletMonitor {
  constructor(private db: Db, private helius: Pick<HeliusClient, 'createWalletWebhook'>, private alertBus: AlertBus) {}

  async trackWallet(address: string, label: string, isMine: boolean) {
    const webhookId = await this.helius.createWalletWebhook(address);
    const [wallet] = await this.db
      .insert(wallets)
      .values({ address, label, isMine, heliusWebhookId: webhookId })
      .returning();
    return wallet;
  }

  async handleWebhookPayload(transactions: HeliusEnhancedTransaction[]) {
    for (const tx of transactions) {
      await this.handleTransaction(tx);
    }
  }

  private async handleTransaction(tx: HeliusEnhancedTransaction) {
    const trackedWallets = await this.db.select().from(wallets);
    for (const wallet of trackedWallets) {
      try {
        await this.handleTransactionForWallet(tx, wallet);
      } catch (err) {
        console.error(`wallet monitor: failed processing tx ${tx.signature} for wallet ${wallet.id}`, err);
      }
    }
  }

  private async handleTransactionForWallet(tx: HeliusEnhancedTransaction, wallet: typeof wallets.$inferSelect) {
    const parsed = parseSwap(tx, wallet.address);
    if (!parsed) return;

    const [trade] = await this.db
      .insert(walletTrades)
      .values({
        walletId: wallet.id,
        signature: parsed.signature,
        mint: parsed.mint,
        side: parsed.side,
        solAmount: parsed.solAmount,
        tokenAmount: parsed.tokenAmount,
        ts: parsed.ts,
      })
      .onConflictDoNothing()
      .returning();
    if (!trade) return; // duplicate delivery of a signature we already recorded

    const payload = {
      walletId: wallet.id,
      walletLabel: wallet.label,
      mint: parsed.mint,
      side: parsed.side,
      solAmount: parsed.solAmount,
      tokenAmount: parsed.tokenAmount,
      axiomLink: buildAxiomLink(parsed.mint),
    };
    const [alert] = await this.db
      .insert(alerts)
      .values({ type: parsed.side === 'buy' ? 'wallet_buy' : 'wallet_sell', refId: trade.id, payload })
      .returning();

    this.alertBus.publish({ type: alert.type, refId: alert.refId, payload: alert.payload });
  }
}
