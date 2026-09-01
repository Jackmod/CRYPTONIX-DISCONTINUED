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

export interface AlertRecord {
  id: number;
  type: string;
  refId: number;
  payload: unknown;
  ts: string;
}

/** An X account being followed. Mirrors apps/engine's tracked_handles row. */
export interface TrackedHandle {
  id: number;
  handle: string;
  lastTweetId: string | null;
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

/**
 * A hung engine — not refused, just silent — otherwise blocks on undici's
 * 300s header timeout per attempt, so the retry loops in loadUntilSuccessful
 * and AlertReplay.start sit in ClientReady with no alert subscription and
 * nothing in the log. Fail fast so those loops can actually loop.
 */
const REQUEST_TIMEOUT_MS = 10_000;

export class EngineClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  /**
   * For calls whose body we never read.
   *
   * An unread response body keeps its undici socket checked out until GC.
   * HeliusClient works around the same thing explicitly; the cursor save runs
   * on every advance, so it is squarely on the hot path.
   */
  private async requestDiscardingBody(path: string, init?: RequestInit): Promise<void> {
    const res = await this.request(path, init);
    await res.body?.cancel().catch(() => {});
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      // Every engine route except /webhooks/helius requires this key.
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${this.apiKey}` },
      });
    } catch (err) {
      throw new EngineError(`engine unreachable: ${(err as Error).message}`, 0);
    }
    if (!res.ok) {
      // The engine answers errors as {"error": "..."}. Surface that sentence on
      // its own: it is written for a human, and it ends up verbatim in a
      // Discord reply. Falling back to the raw body keeps unexpected shapes
      // debuggable rather than silently blank.
      const body = await res.text();
      let message = body;
      try {
        const parsed = JSON.parse(body) as { error?: string };
        if (typeof parsed.error === 'string') message = parsed.error;
      } catch {
        // not JSON; keep the raw body
      }
      throw new EngineError(message, res.status);
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
    await this.requestDiscardingBody(`/wallets/${id}`, { method: 'DELETE' });
  }

  async getPnl(walletId: number): Promise<DailyPnlRow[]> {
    const res = await this.request(`/wallets/${walletId}/pnl`);
    return res.json() as Promise<DailyPnlRow[]>;
  }

  /**
   * Alerts published after `since`, oldest first.
   *
   * The WebSocket only reaches clients connected at the moment of publication,
   * so a trade landing during a restart or a reconnect backoff was recorded
   * and then never delivered. This is the catch-up path.
   */
  async listAlertsSince(since: number): Promise<AlertRecord[]> {
    const res = await this.request(`/alerts?since=${encodeURIComponent(String(since))}`);
    return res.json() as Promise<AlertRecord[]>;
  }

  /**
   * The newest alert id, or 0 when there are none.
   *
   * Used to resume from "now" on a first run. listAlertsSince(0) cannot serve
   * this: it returns an ascending, capped page, so it would hand back the
   * OLDEST rows and make the next catch-up replay real history.
   */
  async getAlertHead(): Promise<number> {
    const res = await this.request('/alerts/head');
    const body = (await res.json()) as { id?: number };
    return typeof body.id === 'number' ? body.id : 0;
  }

  /** Reads a stored value, or null if the key has never been written. */
  async getState(key: string): Promise<string | null> {
    const res = await this.request(`/state/${encodeURIComponent(key)}`);
    const body = (await res.json()) as { value?: string | null };
    return body.value ?? null;
  }

  async setState(key: string, value: string): Promise<void> {
    await this.requestDiscardingBody(`/state/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
  }

  async listHandles(): Promise<TrackedHandle[]> {
    const res = await this.request('/handles');
    return res.json() as Promise<TrackedHandle[]>;
  }

  async trackHandle(handle: string): Promise<TrackedHandle> {
    const res = await this.request('/handles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    });
    return res.json() as Promise<TrackedHandle>;
  }

  async untrackHandle(id: number): Promise<void> {
    await this.requestDiscardingBody(`/handles/${id}`, { method: 'DELETE' });
  }

  async listGuildConfigs(): Promise<GuildConfig[]> {
    const res = await this.request('/discord/guilds');
    return res.json() as Promise<GuildConfig[]>;
  }

  /**
   * Removes a server's routing row. Called when the bot is kicked: without it
   * the row outlives the membership, gets reloaded on the next restart, and
   * every alert then fails fetching a channel the bot can no longer see.
   */
  async deleteGuildConfig(guildId: string): Promise<void> {
    await this.requestDiscardingBody(`/discord/guilds/${guildId}`, { method: 'DELETE' });
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
