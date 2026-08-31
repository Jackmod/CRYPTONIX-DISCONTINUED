import type { DailyPnlRow } from '@cryptonix/core';

export interface Wallet {
  id: number;
  address: string;
  label: string;
  isMine: boolean;
  heliusWebhookId: string | null;
  backfillStatus: string;
  addedAt: string;
}

export interface GuildConfig {
  guildId: string;
  alertChannelId: string;
  setupBy: string | null;
  setupAt: string;
}

/**
 * Every failure reaching a command handler is one of these, so handlers can
 * branch on `status` instead of sniffing error messages. `status: 0` means the
 * request never got a response at all — engine down, DNS failure, refused
 * connection — which is the case users hit most often, since the engine is a
 * separate process.
 */
export class EngineError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'EngineError';
  }
}

export class EngineClient {
  constructor(private baseUrl: string) {}

  private async request(path: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, init);
    } catch (err) {
      throw new EngineError(`engine unreachable: ${(err as Error).message}`, 0);
    }
    if (!res.ok) {
      throw new EngineError(`engine ${init?.method ?? 'GET'} ${path} failed: ${await res.text()}`, res.status);
    }
    return res;
  }

  async listWallets(): Promise<Wallet[]> {
    const res = await this.request('/wallets');
    return res.json() as Promise<Wallet[]>;
  }

  async trackWallet(address: string, label: string, isMine: boolean): Promise<Wallet> {
    const res = await this.request('/wallets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, label, isMine }),
    });
    return res.json() as Promise<Wallet>;
  }

  async untrackWallet(id: number): Promise<void> {
    // 204 No Content: there is no body, so do not touch res.json().
    await this.request(`/wallets/${id}`, { method: 'DELETE' });
  }

  async getPnl(walletId: number): Promise<DailyPnlRow[]> {
    const res = await this.request(`/wallets/${walletId}/pnl`);
    return res.json() as Promise<DailyPnlRow[]>;
  }

  async listGuildConfigs(): Promise<GuildConfig[]> {
    const res = await this.request('/discord/guilds');
    return res.json() as Promise<GuildConfig[]>;
  }

  async setGuildConfig(guildId: string, alertChannelId: string, setupBy?: string): Promise<GuildConfig> {
    const res = await this.request(`/discord/guilds/${guildId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertChannelId, setupBy }),
    });
    return res.json() as Promise<GuildConfig>;
  }
}
