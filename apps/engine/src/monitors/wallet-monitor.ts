import type { Db } from '@cryptonix/db';
import { wallets, walletTrades, pnlDaily, alerts } from '@cryptonix/db';
import { eq } from 'drizzle-orm';
import { parseSwap, buildAxiomLink, type HeliusEnhancedTransaction } from '@cryptonix/core';
import type { HeliusClient } from '../helius/client.js';
import type { AlertBus } from '../api/alert-bus.js';

export class WalletMonitor {
  constructor(
    private db: Db,
    private helius: Pick<HeliusClient, 'createWalletWebhook' | 'deleteWalletWebhook'>,
    private alertBus: AlertBus
  ) {}

  /**
   * Registers a wallet, or returns the one already tracking that address.
   *
   * `created` tells the caller which happened, so the API can answer 409
   * rather than a bare 500 and the bot can say "already tracking".
   *
   * The ordering here is load-bearing. wallets.address is UNIQUE, and the
   * webhook is registered with Helius before any row is written. Creating the
   * webhook first and letting the insert fail on the constraint left a live
   * webhook that no row referenced — an orphan consuming one of the free
   * tier's address slots forever, with nothing recording what held it. So:
   * look first, and if we still lose a race, hand the webhook straight back.
   */
  async trackWallet(address: string, label: string, isMine: boolean) {
    const [existing] = await this.db.select().from(wallets).where(eq(wallets.address, address));
    if (existing) return { wallet: existing, created: false };

    const webhookId = await this.helius.createWalletWebhook(address);
    const [wallet] = await this.db
      .insert(wallets)
      .values({ address, label, isMine, heliusWebhookId: webhookId })
      .onConflictDoNothing()
      .returning();

    if (!wallet) {
      // A concurrent request won the race between our SELECT and INSERT.
      // Give the webhook we just created back rather than orphaning it.
      await this.helius.deleteWalletWebhook(webhookId).catch((err) => {
        console.error(`could not release orphaned webhook ${webhookId}`, err);
      });
      const [raced] = await this.db.select().from(wallets).where(eq(wallets.address, address));
      return { wallet: raced, created: false };
    }

    return { wallet, created: true };
  }

  /**
   * Removes a wallet and everything hanging off it. Returns false if there was
   * no such wallet, so the route can answer 404 rather than pretending.
   *
   * The Helius webhook goes first and on purpose: if Helius refuses (anything
   * but a 404), this throws and the wallet row survives, so the user can retry.
   * The alternative — dropping the row anyway — leaves an orphaned webhook
   * firing at /webhooks/helius forever against a wallet we can no longer
   * identify, permanently consuming one of the free tier's address slots.
   */
  async untrackWallet(walletId: number): Promise<boolean> {
    const [wallet] = await this.db.select().from(wallets).where(eq(wallets.id, walletId));
    if (!wallet) return false;

    if (wallet.heliusWebhookId) {
      await this.helius.deleteWalletWebhook(wallet.heliusWebhookId);
    }

    // Children before parent: both tables carry a FK onto wallets.id.
    await this.db.delete(pnlDaily).where(eq(pnlDaily.walletId, walletId));
    await this.db.delete(walletTrades).where(eq(walletTrades.walletId, walletId));
    await this.db.delete(wallets).where(eq(wallets.id, walletId));
    return true;
  }

  /**
   * Returns the distinct ids of wallets that received a NEW trade row in this
   * batch (i.e. excludes duplicates and irrelevant transactions), so the
   * caller knows which wallets' PnL needs recomputing.
   */
  async handleWebhookPayload(transactions: HeliusEnhancedTransaction[]): Promise<number[]> {
    // Fetch the tracked wallets once per batch, not once per transaction.
    // A failure here must NOT be swallowed: the route needs to see it and
    // return a non-2xx so Helius retries the whole batch. If we ate the
    // error and returned 200 (as this used to), Helius would consider the
    // batch delivered and never retry, permanently losing those trades —
    // there is no re-backfill path to recover them.
    const trackedWallets = await this.db.select().from(wallets);

    const walletIdsWithNewTrades = new Set<number>();

    for (const tx of transactions) {
      for (const wallet of trackedWallets) {
        try {
          const inserted = await this.handleTransactionForWallet(tx, wallet);
          if (inserted) walletIdsWithNewTrades.add(wallet.id);
        } catch (err) {
          // Per-wallet isolation: one wallet's failure must not stop the
          // others in the same batch (spec §9 fault isolation) — this stays
          // a swallow-and-log, unlike the batch-level fetch above.
          console.error(`wallet monitor: failed processing tx ${tx.signature} for wallet ${wallet.id}`, err);
        }
      }
    }

    return [...walletIdsWithNewTrades];
  }

  /** Returns true if a new trade row was inserted (false for a duplicate or irrelevant tx). */
  private async handleTransactionForWallet(tx: HeliusEnhancedTransaction, wallet: typeof wallets.$inferSelect): Promise<boolean> {
    const parsed = parseSwap(tx, wallet.address);
    if (!parsed) return false;

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
    if (!trade) return false; // duplicate delivery of a signature we already recorded

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
    return true;
  }
}
