import type { HeliusClient } from './client.js';

/**
 * One Helius webhook watching every tracked wallet.
 *
 * The engine used to create a webhook per wallet, which quietly capped the
 * whole product: Helius allows **five webhooks on the free tier** but a
 * hundred thousand addresses in each. So tracking a sixth wallet failed, while
 * a single webhook was using one twenty-thousandth of what it could hold. One
 * shared webhook turns that ceiling from 5 into 100,000.
 *
 * It also costs less. Management calls are 100 credits each; adding a wallet
 * is now one edit rather than one create, and removing the last wallet is the
 * only thing that ever deletes anything.
 *
 * The webhook is identified by its delivery URL rather than by a stored id, so
 * there is no id to persist, lose, or migrate — and if it is deleted from the
 * Helius dashboard, the next `register` simply builds it again.
 */
export class WalletWebhook {
  /** Remembered after the first lookup; listing costs a round trip. */
  private cachedId: string | null = null;

  /**
   * Serialises every mutation.
   *
   * Helius's PUT replaces the address list rather than appending to it, so
   * each edit is a read-modify-write. Two concurrent `/track` calls would
   * otherwise both read the same list and the second would erase the first's
   * address — the wallet would be saved in our database and silently never
   * watched.
   *
   * One process is enough for that guarantee here, because the engine is the
   * single writer by design (spec §9). Two engines sharing one Helius account
   * would still race, and would need a lock in Postgres rather than in memory.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly helius: Pick<
      HeliusClient,
      'listWebhooks' | 'createWalletWebhook' | 'setWebhookAddresses' | 'deleteWalletWebhook' | 'webhookUrl'
    >
  ) {}

  /**
   * Starts watching an address, and returns the shared webhook's id.
   *
   * Idempotent: re-registering an address already being watched is a no-op
   * that still returns the id, which is what makes `trackWallet`'s repair path
   * safe to run against a wallet that is actually fine.
   */
  register(address: string): Promise<string> {
    return this.serialize(async () => {
      const existing = await this.find();

      if (!existing) {
        const id = await this.helius.createWalletWebhook([address]);
        this.cachedId = id;
        return id;
      }

      const addresses = existing.accountAddresses ?? [];
      if (addresses.includes(address)) return existing.webhookID;

      await this.helius.setWebhookAddresses(existing.webhookID, [...addresses, address]);
      return existing.webhookID;
    });
  }

  /**
   * Stops watching an address.
   *
   * Deleting the webhook when the last address goes matters: Helius rejects an
   * empty address list, and leaving an empty webhook behind would hold one of
   * the five free-tier slots for nothing.
   */
  release(address: string): Promise<void> {
    return this.serialize(async () => {
      const existing = await this.find();
      if (!existing) return;

      const remaining = (existing.accountAddresses ?? []).filter((a) => a !== address);
      // Nothing to do, and importantly no pointless 100-credit edit.
      if (remaining.length === (existing.accountAddresses ?? []).length) return;

      if (remaining.length === 0) {
        await this.helius.deleteWalletWebhook(existing.webhookID);
        this.cachedId = null;
        return;
      }

      await this.helius.setWebhookAddresses(existing.webhookID, remaining);
    });
  }

  /** Ours is the one whose delivery URL is ours. */
  private async find() {
    const webhooks = await this.helius.listWebhooks();
    const mine = webhooks.find((w) => w.webhookURL === this.helius.webhookUrl);
    // Re-read every time rather than trusting the cache: the address list is
    // what each edit depends on, and it can change from the Helius dashboard.
    // The cached id is only a hint that one exists.
    this.cachedId = mine?.webhookID ?? null;
    return mine ?? null;
  }

  /** Runs `task` after everything already queued, whether those failed or not. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // Swallowed on the chain only: a rejection must not stop the next caller,
    // but it still reaches whoever awaited this call.
    this.queue = run.catch(() => undefined);
    return run;
  }
}
