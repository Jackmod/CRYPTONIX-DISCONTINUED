import type { Db } from '@cryptonix/db';
import { wallets, walletTrades, pnlDaily, alerts } from '@cryptonix/db';
import { and, eq, isNull } from 'drizzle-orm';
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
   * webhook first and letting the write fail left a live webhook that no row
   * referenced — an orphan consuming one of the free tier's address slots
   * forever, with nothing recording what held it. So: look first, and if the
   * write does not land for ANY reason — lost race, pool exhaustion, timeout,
   * connection reset — hand the webhook straight back before giving up.
   */
  async trackWallet(address: string, label: string, isMine: boolean) {
    // Bounded retry: losing the race to a writer that then untracks leaves
    // nothing to return, and a second pass resolves it. Two attempts is
    // plenty for a window this narrow, and it cannot spin.
    for (let attempt = 0; attempt < 2; attempt++) {
      const [existing] = await this.db.select().from(wallets).where(eq(wallets.address, address));
      if (existing?.heliusWebhookId) return { wallet: existing, created: false, healed: false };

      if (existing) {
        // Tracked, but holding no webhook: either untrackWallet released the
        // webhook and then failed to remove the rows, or the row was inserted
        // directly (the smoke test's --skip-helius path). Either way it would
        // sit there answering 409 "already tracked" forever while receiving no
        // alerts. Register a webhook and heal it instead.
        const healedWebhookId = await this.helius.createWalletWebhook(address);

        let healed: typeof wallets.$inferSelect | undefined;
        try {
          [healed] = await this.db
            .update(wallets)
            .set({ heliusWebhookId: healedWebhookId })
            // Only claim the row if it still has no webhook. Two concurrent
            // requests both saw NULL, so both created one; without this guard
            // both UPDATEs succeed and the loser's webhook is orphaned — the
            // same invariant the insert path protects with onConflictDoNothing.
            // The loser gets no row back and falls into the release-and-retry
            // branch below.
            .where(and(eq(wallets.id, existing.id), isNull(wallets.heliusWebhookId)))
            .returning();
        } catch (err) {
          // Same invariant as the insert path: a webhook exists that no row
          // references. Release it before the error escapes.
          await this.releaseWebhook(healedWebhookId);
          throw err;
        }

        if (!healed) {
          // Either the row was untracked between our SELECT and this UPDATE, or
          // a concurrent heal claimed it first. Either way the webhook we just
          // made belongs to nothing: release it and loop, so the next pass
          // sees the real current state.
          await this.releaseWebhook(healedWebhookId);
          continue;
        }

        console.warn(`wallet ${existing.id} had no Helius webhook; re-registered as ${healedWebhookId}`);
        // `healed` matters to the caller: this row reached us mid-repair, most
        // likely from an untrack that released the webhook and then failed to
        // delete the rows. Its trade history may be partly gone, and only a
        // backfill puts it back — answering a plain 409 would re-webhook the
        // wallet and leave it permanently empty.
        return { wallet: healed, created: false, healed: true };
      }

      const webhookId = await this.helius.createWalletWebhook(address);

      let inserted: typeof wallets.$inferSelect | undefined;
      try {
        [inserted] = await this.db
          .insert(wallets)
          .values({ address, label, isMine, heliusWebhookId: webhookId })
          .onConflictDoNothing()
          .returning();
      } catch (err) {
        // The webhook exists but no row references it. Release it before the
        // error propagates, or it is orphaned for good.
        await this.releaseWebhook(webhookId);
        throw err;
      }

      if (inserted) return { wallet: inserted, created: true, healed: false };

      // ON CONFLICT: a concurrent request won. Give our webhook back.
      await this.releaseWebhook(webhookId);

      const [raced] = await this.db.select().from(wallets).where(eq(wallets.address, address));
      if (raced) return { wallet: raced, created: false, healed: false };
      // The winner untracked between our INSERT and this SELECT, so the
      // address is free again — loop and register it properly.
    }

    throw new Error(`could not register ${address}: it was concurrently added and removed twice`);
  }

  /** Best-effort webhook release; never masks the error that caused it. */
  private async releaseWebhook(webhookId: string): Promise<void> {
    await this.helius.deleteWalletWebhook(webhookId).catch((err) => {
      console.error(`could not release orphaned webhook ${webhookId}`, err);
    });
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
      // Record that the webhook is gone before touching anything else. If the
      // row deletions below fail, the wallet survives with a NULL webhook id,
      // which is the truth — and trackWallet heals that state. Leaving the
      // stale id would make the row look tracked while silently receiving
      // nothing, forever.
      await this.db.update(wallets).set({ heliusWebhookId: null }).where(eq(wallets.id, walletId));
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
