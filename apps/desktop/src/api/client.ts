export interface Wallet {
  id: number;
  address: string;
  label: string;
  isMine: boolean;
  heliusWebhookId: string | null;
  backfillStatus: string;
  addedAt: string;
}

export interface Trade {
  id: number;
  walletId: number;
  signature: string;
  mint: string;
  side: 'buy' | 'sell';
  solAmount: number;
  tokenAmount: number;
  ts: string;
}

export interface DailyPnl {
  date: string;
  realizedPnlSol: number;
  tradeCount: number;
}

export interface Coin {
  mint: string;
  symbol: string;
  momentumScore: number | null;
  imageUrl: string | null;
  stats: {
    ageMinutes?: number;
    volume5m?: number;
    priceChange5m?: number;
    buys5m?: number;
    sells5m?: number;
    liquidityUsd?: number | null;
  } | null;
  firstSeenAt: string;
}

/** An X account being followed. Mirrors the engine's tracked_handles row. */
export interface TrackedHandle {
  id: number;
  handle: string;
  lastTweetId: string | null;
  addedAt: string;
}

export interface StoredTweet {
  id: string;
  handle: string;
  authorName: string;
  authorAvatarUrl: string | null;
  text: string;
  media: { type: string; url: string }[];
  url: string;
  likeCount: number | null;
  replyCount: number | null;
  postedAt: string;
}

/** What the engine reports it is actually doing. */
export interface EngineHealth {
  ok: boolean;
  features: {
    coinScanner: boolean;
    tweetMonitor: boolean;
  };
}

export interface AlertRecord {
  id: number;
  type: string;
  refId: number;
  payload: unknown;
  ts: string;
}

/**
 * Every failure surfaces as one of these, so views can tell "the engine is
 * not running" apart from "the engine said no" without sniffing messages.
 * `status: 0` means the request never got a response at all, which is the
 * case a local app hits most: the engine simply is not up yet.
 */
export class EngineError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'EngineError';
  }
}

/** A hung engine must not leave the UI spinning with no explanation. */
const REQUEST_TIMEOUT_MS = 10_000;

export class EngineClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  private async request(path: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${this.apiKey}` },
      });
    } catch (err) {
      throw new EngineError(`cannot reach the engine: ${(err as Error).message}`, 0);
    }

    if (!res.ok) {
      // The engine answers errors as {"error": "..."}, written for a person.
      // Surface that sentence rather than a serialised body.
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

  private async json<T>(path: string): Promise<T> {
    return (await this.request(path)).json() as Promise<T>;
  }

  listWallets(): Promise<Wallet[]> {
    return this.json('/wallets');
  }

  listTrades(walletId: number): Promise<Trade[]> {
    return this.json(`/wallets/${walletId}/trades`);
  }

  listPnl(walletId: number): Promise<DailyPnl[]> {
    return this.json(`/wallets/${walletId}/pnl`);
  }

  async getBalance(walletId: number): Promise<number> {
    const body = await this.json<{ sol?: number }>(`/wallets/${walletId}/balance`);
    return typeof body.sol === 'number' ? body.sol : 0;
  }

  getHealth(): Promise<EngineHealth> {
    return this.json('/health');
  }

  listHandles(): Promise<TrackedHandle[]> {
    return this.json('/handles');
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
    const res = await this.request(`/handles/${id}`, { method: 'DELETE' });
    await res.body?.cancel().catch(() => {});
  }

  listTweets(limit = 50): Promise<StoredTweet[]> {
    return this.json(`/tweets?limit=${encodeURIComponent(String(limit))}`);
  }

  listCoins(limit = 50): Promise<Coin[]> {
    return this.json(`/coins?limit=${encodeURIComponent(String(limit))}`);
  }

  listAlertsSince(since: number): Promise<AlertRecord[]> {
    return this.json(`/alerts?since=${encodeURIComponent(String(since))}`);
  }

  /**
   * The newest alerts, most recent first.
   *
   * `/alerts?since=0` cannot seed a viewer: it is an ascending capped page, so
   * it answers with the OLDEST alerts in the whole history.
   */
  listRecentAlerts(limit = 100): Promise<AlertRecord[]> {
    return this.json(`/alerts/recent?limit=${encodeURIComponent(String(limit))}`);
  }

  async trackWallet(address: string, label: string, isMine: boolean): Promise<Wallet> {
    const res = await this.request('/wallets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, label, isMine }),
    });
    return res.json() as Promise<Wallet>;
  }

  /**
   * Rename a wallet, or change whether it is one of yours.
   *
   * The address is not editable: changing it would point a wallet's whole
   * recorded history at a different account.
   */
  async updateWallet(id: number, changes: { label?: string; isMine?: boolean }): Promise<Wallet> {
    const res = await this.request(`/wallets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    });
    return res.json() as Promise<Wallet>;
  }

  async untrackWallet(id: number): Promise<void> {
    // 204 No Content: there is no body to read.
    const res = await this.request(`/wallets/${id}`, { method: 'DELETE' });
    await res.body?.cancel().catch(() => {});
  }
}
