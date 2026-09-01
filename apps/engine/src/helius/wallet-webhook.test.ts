import { describe, it, expect, vi } from 'vitest';
import { WalletWebhook } from './wallet-webhook';
import type { HeliusWebhook } from './client';

const URL = 'https://tunnel.example/webhooks/helius';

/**
 * A Helius stand-in holding one webhook's worth of state, so the tests assert
 * on what Helius would end up watching rather than on which calls were made.
 */
function fakeHelius(initial: HeliusWebhook[] = []) {
  const state = initial.map((w) => ({ ...w, accountAddresses: [...(w.accountAddresses ?? [])] }));
  let nextId = 1;

  const helius = {
    webhookUrl: URL,
    listWebhooks: vi.fn(async () => state.map((w) => ({ ...w, accountAddresses: [...w.accountAddresses!] }))),
    createWalletWebhook: vi.fn(async (addresses: string[]) => {
      const webhookID = `wh_${nextId++}`;
      state.push({ webhookID, webhookURL: URL, accountAddresses: [...addresses] });
      return webhookID;
    }),
    setWebhookAddresses: vi.fn(async (id: string, addresses: string[]) => {
      const hook = state.find((w) => w.webhookID === id);
      if (!hook) throw new Error('no such webhook');
      hook.accountAddresses = [...addresses];
    }),
    deleteWalletWebhook: vi.fn(async (id: string) => {
      const at = state.findIndex((w) => w.webhookID === id);
      if (at >= 0) state.splice(at, 1);
    }),
  };

  return { helius, state, addresses: () => state[0]?.accountAddresses ?? [] };
}

describe('WalletWebhook', () => {
  it('creates one webhook for the first address', async () => {
    const { helius, state, addresses } = fakeHelius();
    const id = await new WalletWebhook(helius).register('A');

    expect(id).toBe('wh_1');
    expect(state).toHaveLength(1);
    expect(addresses()).toEqual(['A']);
  });

  it('adds later wallets to the SAME webhook rather than making new ones', async () => {
    // The whole point: Helius allows five webhooks on the free tier but
    // 100,000 addresses in each, so a webhook per wallet capped the product
    // at five wallets.
    const { helius, state, addresses } = fakeHelius();
    const webhook = new WalletWebhook(helius);

    for (const address of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) await webhook.register(address);

    expect(state).toHaveLength(1);
    expect(addresses()).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    expect(helius.createWalletWebhook).toHaveBeenCalledTimes(1);
  });

  it('returns the same webhook id for every wallet', async () => {
    const { helius } = fakeHelius();
    const webhook = new WalletWebhook(helius);

    expect(await webhook.register('A')).toBe(await webhook.register('B'));
  });

  it('registering an address twice changes nothing and costs no edit', async () => {
    // Management calls cost 100 credits each; the repair path in trackWallet
    // re-registers wallets that are already fine.
    const { helius, addresses } = fakeHelius();
    const webhook = new WalletWebhook(helius);

    await webhook.register('A');
    helius.setWebhookAddresses.mockClear();
    await webhook.register('A');

    expect(addresses()).toEqual(['A']);
    expect(helius.setWebhookAddresses).not.toHaveBeenCalled();
  });

  it('removes only the address it was asked to', async () => {
    const { helius, addresses } = fakeHelius();
    const webhook = new WalletWebhook(helius);

    await webhook.register('A');
    await webhook.register('B');
    await webhook.release('A');

    expect(addresses()).toEqual(['B']);
  });

  it('deletes the webhook when the last address goes', async () => {
    // Helius rejects an empty address list, and an empty webhook would hold
    // one of the five free-tier slots for nothing.
    const { helius, state } = fakeHelius();
    const webhook = new WalletWebhook(helius);

    await webhook.register('A');
    await webhook.release('A');

    expect(state).toHaveLength(0);
    expect(helius.deleteWalletWebhook).toHaveBeenCalledTimes(1);
  });

  it('builds a fresh webhook after the last one was deleted', async () => {
    const { helius, addresses } = fakeHelius();
    const webhook = new WalletWebhook(helius);

    await webhook.register('A');
    await webhook.release('A');
    await webhook.register('B');

    expect(addresses()).toEqual(['B']);
  });

  it('releasing an address nobody watches costs no call', async () => {
    const { helius } = fakeHelius();
    const webhook = new WalletWebhook(helius);
    await webhook.register('A');
    helius.setWebhookAddresses.mockClear();
    helius.deleteWalletWebhook.mockClear();

    await webhook.release('SOMETHING-ELSE');

    expect(helius.setWebhookAddresses).not.toHaveBeenCalled();
    expect(helius.deleteWalletWebhook).not.toHaveBeenCalled();
  });

  it('releasing when no webhook exists at all is a no-op', async () => {
    const { helius } = fakeHelius();
    await expect(new WalletWebhook(helius).release('A')).resolves.toBeUndefined();
  });

  it('does not lose an address when two registrations race', async () => {
    // PUT replaces the list rather than appending, so both would read the same
    // state and the second would erase the first — the wallet would be saved
    // in our database and silently never watched.
    const { helius, addresses } = fakeHelius();
    const webhook = new WalletWebhook(helius);

    await Promise.all([webhook.register('A'), webhook.register('B'), webhook.register('C')]);

    expect(addresses().sort()).toEqual(['A', 'B', 'C']);
  });

  it('does not resurrect an address when a register and a release race', async () => {
    const { helius, addresses } = fakeHelius();
    const webhook = new WalletWebhook(helius);
    await webhook.register('A');

    await Promise.all([webhook.register('B'), webhook.release('A')]);

    expect(addresses()).toEqual(['B']);
  });

  it('keeps serving later callers after one fails', async () => {
    const { helius, addresses } = fakeHelius();
    const webhook = new WalletWebhook(helius);
    helius.createWalletWebhook.mockRejectedValueOnce(new Error('helius is down'));

    await expect(webhook.register('A')).rejects.toThrow('helius is down');
    await expect(webhook.register('B')).resolves.toBe('wh_1');
    expect(addresses()).toEqual(['B']);
  });

  it('ignores webhooks belonging to something else on the same account', async () => {
    // A Helius account can serve more than this engine; only the one whose
    // delivery URL is ours may be edited.
    const { helius, state } = fakeHelius([
      { webhookID: 'someone-else', webhookURL: 'https://other.example/hook', accountAddresses: ['X'] },
    ]);

    await new WalletWebhook(helius).register('A');

    expect(state).toHaveLength(2);
    expect(state.find((w) => w.webhookID === 'someone-else')!.accountAddresses).toEqual(['X']);
  });

  it('adopts a webhook that already exists at our URL, rather than making a second', async () => {
    // After a restart, or when the id was never persisted anywhere.
    const { helius, state, addresses } = fakeHelius([
      { webhookID: 'wh_existing', webhookURL: URL, accountAddresses: ['A'] },
    ]);

    const id = await new WalletWebhook(helius).register('B');

    expect(id).toBe('wh_existing');
    expect(state).toHaveLength(1);
    expect(addresses()).toEqual(['A', 'B']);
  });

  it('re-reads the address list rather than trusting a cached copy', async () => {
    // It can change from the Helius dashboard between our own edits.
    const { helius, addresses } = fakeHelius();
    const webhook = new WalletWebhook(helius);
    await webhook.register('A');

    // Someone adds an address outside this engine.
    await helius.setWebhookAddresses('wh_1', ['A', 'MANUAL']);
    await webhook.register('B');

    expect(addresses()).toEqual(['A', 'MANUAL', 'B']);
  });
});
