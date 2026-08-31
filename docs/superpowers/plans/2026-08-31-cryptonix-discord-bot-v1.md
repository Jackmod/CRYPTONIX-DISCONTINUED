# Cryptonix Discord Bot v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `apps/discord-bot` — a discord.js process that posts live wallet-buy alerts as rich embeds with an Axiom link button, and serves `/track wallet`, `/untrack wallet`, and `/pnl` slash commands against the existing engine.

**Architecture:** The bot is a pure consumer of the engine's two existing seams: the WebSocket at `/ws` for alerts, and the REST API for commands. It gets no database access of its own — the engine stays the single writer, so a bot crash cannot corrupt state (spec §9). All I/O-free logic (PnL summarising, heatmap grid maths) lives in `packages/core` so the Phase 4 desktop app reuses it instead of reimplementing it. The engine gains one small capability it is missing today: wallet removal, including Helius webhook teardown.

**Tech Stack:** TypeScript, discord.js v14 (14.25.x), `ws`, Vitest, existing pnpm/Turborepo monorepo.

**Spec:** `docs/superpowers/specs/2026-08-30-cryptonix-design.md` (§5.2 discord-bot, §7 third-party constraints, §8 codebase structure, §9 resilience, §10 testing, §11 build order Phase 2)

## Global Constraints

- Solana only — no other chains (spec §2/§3).
- Free-tier infrastructure only (spec §2, §7). The Helius free tier caps webhook addresses, so **every wallet removal must delete its Helius webhook** or the cap leaks (spec §7).
- No automated trade execution — the bot produces Axiom links only, never places trades (spec §3).
- One clear responsibility per file; no god-files (spec §8, §9).
- PnL is native SOL via FIFO, never per-token USD feeds (spec §5.1, §6).
- The bot must never take the engine down, and must survive the engine being down (spec §9).
- **Import convention (this repo):** relative imports in *source* files carry the `.js` extension (NodeNext), e.g. `./alert-bus.js`. Relative imports in *test* files omit it, e.g. `./client`. Test files are excluded from `tsc` builds. Match this exactly — it is why `packages/*/tsconfig.json` sets `"exclude": ["src/**/*.test.ts"]`.
- **Package layout convention:** every package/app extends `@cryptonix/config/tsconfig.base.json` and sets its own `rootDir: "src"` / `outDir: "dist"`. Do not put `rootDir`/`outDir` in the shared base — it broke the build once already.
- Tests must never make live Discord or live Helius calls. Mock `fetch`, inject fake WebSocket constructors, and build embeds as pure functions over fixtures (spec §10).

---

## Deviations from the spec (agreed, not oversights)

- **§5.2 says `/pnl` attaches "a server-rendered calendar heatmap image".** This plan renders the calendar as a grid of coloured emoji squares inside the embed instead. It ships in v1 with no native canvas dependency and no image build step, at the cost of a coarser five-level scale. Decided with the project owner on 2026-08-31. A real rendered PNG remains a possible later refinement; nothing here blocks it, since the grid is already computed as structured data by `buildHeatmapGrid` and only the final `renderHeatmap` step assumes emoji.
- **The mockup that decision was made from showed a `Mo Tu We…` weekday header.** It is not in this plan: emoji cells are roughly double the width of Latin letters, so such a header cannot align on any client. The embed footer carries "Weeks run Monday→Sunday" instead.
- **§5.2 lists `/track twitter <handle>` alongside `/track wallet`.** Twitter tracking belongs to Phase 3 (§11.3), which builds the monitor that would give it something to do. Only the wallet subcommand ships here.
- **§5.2 describes a wallet-*buy* alert; this plan renders sells too.** The engine already publishes `wallet_sell` from the same code path, so handling only buys would silently drop half the stream.

---

## Prerequisites (do this before Task 5)

Tasks 1–4 need nothing external. Before Task 5 you need a Discord bot identity:

1. Go to https://discord.com/developers/applications → **New Application**, name it Cryptonix.
2. **Bot** tab → **Reset Token** → copy the token. This is `DISCORD_TOKEN`. Treat it like a password; it goes in `.env`, which is gitignored.
3. **General Information** tab → copy **Application ID**. This is `DISCORD_CLIENT_ID`.
4. **Installation** (or **OAuth2 → URL Generator**) → scopes `bot` and `applications.commands`; bot permissions **Send Messages** and **Embed Links**. Open the generated URL and invite the bot to your server.
5. In Discord, enable **Settings → Advanced → Developer Mode**, then right-click your server → **Copy Server ID** (`DISCORD_GUILD_ID`) and right-click the alerts channel → **Copy Channel ID** (`DISCORD_ALERT_CHANNEL_ID`).

---

## File Structure

**Modified — engine (adds wallet removal, which does not exist today):**

| File | Responsibility |
|---|---|
| `apps/engine/src/helius/client.ts` | + `deleteWalletWebhook(webhookId)` |
| `apps/engine/src/monitors/wallet-monitor.ts` | + `untrackWallet(walletId)` — webhook teardown then row deletion |
| `apps/engine/src/api/server.ts` | + `DELETE /wallets/:id` |

**Created — core (pure, reused by Phase 4 desktop):**

| File | Responsibility |
|---|---|
| `packages/core/src/pnl/summarize.ts` | `summarizePnl(rows)` → realized total, win rate, best/worst day |
| `packages/core/src/pnl/heatmap.ts` | `buildHeatmapGrid(rows, month)` + `renderHeatmap(grid)` |

**Created — `apps/discord-bot`:**

| File | Responsibility |
|---|---|
| `src/env.ts` | Validate the six bot env vars |
| `src/engine/client.ts` | Typed REST wrapper over the engine |
| `src/engine/alert-stream.ts` | WS subscriber with backoff reconnect |
| `src/embeds/wallet-buy.ts` | Pure: alert payload → embed + Axiom link button |
| `src/embeds/pnl.ts` | Pure: summary + grid → embed |
| `src/commands/track.ts` | `/track wallet` definition + handler |
| `src/commands/untrack.ts` | `/untrack wallet` definition + handler |
| `src/commands/pnl.ts` | `/pnl` definition + handler |
| `src/commands/registry.ts` | Command table + guild registration |
| `src/index.ts` | Wiring: client login, alert → channel, interaction → handler |

---

### Task 1: Engine — delete a wallet's Helius webhook

`HeliusClient` can create a webhook but has no way to remove one. Every tracked wallet holds its own webhook (`wallets.helius_webhook_id`), and the free tier caps how many you may have (spec §7), so `/untrack` must be able to hand one back.

**Files:**
- Modify: `apps/engine/src/helius/client.ts`
- Test: `apps/engine/src/helius/client.test.ts`

**Interfaces:**
- Produces: `HeliusClient.deleteWalletWebhook(webhookId: string): Promise<void>` — resolves on success **and** on 404 (already gone), throws on any other non-2xx. Task 2 consumes it.

- [x] **Step 1: Write the failing tests**

Append these three cases inside the existing `describe('HeliusClient', ...)` block in `apps/engine/src/helius/client.test.ts`:

```typescript
  it('deletes a webhook by id', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com', webhookSecret: 'secret1' });

    await client.deleteWalletWebhook('wh_123');

    const [url, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/webhooks/wh_123?api-key=key1');
    expect(options.method).toBe('DELETE');
  });

  it('treats a 404 as already deleted rather than an error', async () => {
    // Untracking must stay idempotent: if the webhook is already gone (deleted
    // by hand in the Helius dashboard, or a retried request), the wallet row
    // still has to be removable. Throwing here would strand the wallet as
    // permanently un-untrackable.
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 404, text: async () => 'not found' });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com', webhookSecret: 'secret1' });

    await expect(client.deleteWalletWebhook('wh_gone')).resolves.toBeUndefined();
  });

  it('throws when webhook deletion fails for any other reason', async () => {
    // A 500 or a rate-limit must NOT be swallowed. If we deleted the wallet row
    // anyway, the webhook would keep firing forever against a wallet we no
    // longer know about, burning the free-tier address cap with no way to find it.
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com', webhookSecret: 'secret1' });

    await expect(client.deleteWalletWebhook('wh_123')).rejects.toThrow('Helius webhook delete failed');
  });
```

- [x] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @cryptonix/engine test -- client`
Expected: FAIL — `client.deleteWalletWebhook is not a function`

- [x] **Step 3: Implement**

Add this method to the `HeliusClient` class in `apps/engine/src/helius/client.ts`, directly after `createWalletWebhook`:

```typescript
  /**
   * Hands a webhook address back to the free-tier pool. A 404 means it is
   * already gone, which is a success for our purposes — untracking has to be
   * idempotent. Any other failure throws, because silently dropping the wallet
   * row while leaving a live webhook behind would leak the address cap with no
   * record of what is holding it (spec §7).
   */
  async deleteWalletWebhook(webhookId: string): Promise<void> {
    const res = await fetch(`${HELIUS_BASE}/webhooks/${webhookId}?api-key=${this.config.apiKey}`, {
      method: 'DELETE',
    });
    if (res.status === 404) return;
    if (!res.ok) throw new Error(`Helius webhook delete failed: ${res.status} ${await res.text()}`);
  }
```

- [x] **Step 4: Run and confirm it passes**

Run: `pnpm --filter @cryptonix/engine test -- client`
Expected: PASS — 7 tests in this file

- [x] **Step 5: Commit**

```bash
git add apps/engine/src/helius/client.ts apps/engine/src/helius/client.test.ts
git commit -m "engine: add Helius webhook deletion"
```

---

### Task 2: Engine — untrack a wallet

**Files:**
- Modify: `apps/engine/src/monitors/wallet-monitor.ts`
- Modify: `apps/engine/src/api/server.ts`
- Test: `apps/engine/src/api/server.test.ts`

**Interfaces:**
- Consumes: `HeliusClient.deleteWalletWebhook` from Task 1.
- Produces: `WalletMonitor.untrackWallet(walletId: number): Promise<boolean>` (false when no such wallet) and `DELETE /wallets/:id` → `204` on success, `404` when unknown. Task 6's `EngineClient.untrackWallet` consumes the route.

**Critical ordering:** `wallet_trades.wallet_id` and `pnl_daily.wallet_id` are foreign keys onto `wallets.id` (see `packages/db/src/schema.ts`). Deleting the wallet row first raises a foreign-key violation. Children go first, parent last.

- [x] **Step 1: Add `deleteWalletWebhook` to the test harness's Helius mock**

In `apps/engine/src/api/server.test.ts`, the `buildApp()` helper builds a fake Helius client. Add the new method so it is available to every test in the file:

```typescript
    const helius = {
      createWalletWebhook: vi.fn().mockResolvedValue('wh_1'),
      getTransactionHistory: vi.fn().mockResolvedValue([]),
      deleteWalletWebhook: vi.fn().mockResolvedValue(undefined),
    } as any;
```

- [x] **Step 2: Write the failing tests**

Add these three cases to the `describe('engine API', ...)` block in `apps/engine/src/api/server.test.ts`:

```typescript
  it('DELETE /wallets/:id removes the wallet and releases its Helius webhook', async () => {
    const app = buildApp();
    const createRes = await request(app).post('/wallets').send({ address: 'Addr1', label: 'Test' });
    const walletId = createRes.body.id;

    const delRes = await request(app).delete(`/wallets/${walletId}`);
    expect(delRes.status).toBe(204);

    const listRes = await request(app).get('/wallets');
    expect(listRes.body).toHaveLength(0);
  });

  it('DELETE /wallets/:id removes a wallet that has trades and PnL rows', async () => {
    // wallet_trades and pnl_daily both carry a foreign key onto wallets.id, so
    // deleting the parent row first is a FK violation. This is the regression
    // guard: a wallet is only untrackable in practice once it has history.
    const app = buildApp();
    const createRes = await request(app).post('/wallets').send({ address: 'Addr1', label: 'Test' });
    const walletId = createRes.body.id;

    await request(app)
      .post('/webhooks/helius')
      .set('Authorization', WEBHOOK_SECRET)
      .send([
        {
          signature: 'sig1',
          timestamp: 1_735_000_000,
          type: 'SWAP',
          tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: 'Addr1', mint: 'Mint1', tokenAmount: 100 }],
          nativeTransfers: [{ fromUserAccount: 'Addr1', toUserAccount: 'Pool', amount: 1_000_000_000 }],
        },
      ]);

    const tradesRes = await request(app).get(`/wallets/${walletId}/trades`);
    expect(tradesRes.body.length).toBeGreaterThan(0);

    const delRes = await request(app).delete(`/wallets/${walletId}`);
    expect(delRes.status).toBe(204);
  });

  it('DELETE /wallets/:id returns 404 for an unknown wallet', async () => {
    const app = buildApp();
    const res = await request(app).delete('/wallets/9999');
    expect(res.status).toBe(404);
  });
```

- [x] **Step 3: Run and confirm it fails**

Run: `pnpm --filter @cryptonix/engine test -- server`
Expected: FAIL — the DELETE requests return 404 from Express's default handler because no route is registered

- [x] **Step 4: Implement `untrackWallet`**

Add this method to the `WalletMonitor` class in `apps/engine/src/monitors/wallet-monitor.ts`, after `trackWallet`. Extend the existing `@cryptonix/db` import so `walletTrades` and `pnlDaily` are in scope, and make sure `eq` is imported from `drizzle-orm`:

```typescript
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
```

- [x] **Step 5: Implement the route**

Add this to `apps/engine/src/api/server.ts`, immediately after the `GET /wallets/:id/balance` route. It uses the file's existing `asyncRoute` wrapper and `parseWalletId` helper, so a rejected promise reaches the error boundary instead of crashing the process:

```typescript
  app.delete(
    '/wallets/:id',
    asyncRoute(async (req, res) => {
      const walletId = parseWalletId(req, res);
      if (walletId === null) return;
      const removed = await walletMonitor.untrackWallet(walletId);
      if (!removed) {
        res.status(404).json({ error: 'wallet not found' });
        return;
      }
      res.status(204).end();
    })
  );
```

- [x] **Step 6: Run and confirm it passes**

Run: `pnpm --filter @cryptonix/engine test`
Expected: PASS — all engine tests, now 30

- [x] **Step 7: Commit**

```bash
git add apps/engine/src/monitors/wallet-monitor.ts apps/engine/src/api/server.ts apps/engine/src/api/server.test.ts
git commit -m "engine: add wallet untracking with webhook teardown"
```

---

### Task 3: core — PnL summary

Pure, I/O-free, and deliberately in `packages/core` rather than the bot: the Phase 4 desktop app renders the same numbers (spec §5.3), and duplicating this maths in two UIs is how the two UIs start disagreeing.

**Files:**
- Create: `packages/core/src/pnl/summarize.ts`
- Test: `packages/core/src/pnl/summarize.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface DailyPnlRow { date: string; realizedPnlSol: number; tradeCount: number }
  export interface PnlSummary {
    realizedSol: number;
    tradingDays: number;
    winDays: number;
    lossDays: number;
    winRate: number | null;
    best: DailyPnlRow | null;
    worst: DailyPnlRow | null;
  }
  export function summarizePnl(rows: DailyPnlRow[]): PnlSummary
  ```
  `DailyPnlRow` mirrors the shape `GET /wallets/:id/pnl` returns from the `pnl_daily` table (`date` is `'YYYY-MM-DD'` text). Tasks 4, 6 and 9 all consume these two types.

**Definitions, so the numbers mean one thing only:**
- A *trading day* is a row with `tradeCount > 0`. Rows with no trades never count toward win rate — otherwise a quiet month silently drags it toward zero.
- `winRate` is `winDays / tradingDays`, a fraction in `[0, 1]`. It is `null` when there are no trading days, never `0` — "no data" and "lost every day" must not render identically.
- A break-even day (`realizedPnlSol === 0`) counts as a trading day but as neither a win nor a loss.
- Ties for best/worst resolve to the earlier date.

- [x] **Step 1: Write the failing tests**

Create `packages/core/src/pnl/summarize.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { summarizePnl } from './summarize';

describe('summarizePnl', () => {
  it('returns an empty summary for no rows', () => {
    const summary = summarizePnl([]);

    expect(summary.realizedSol).toBe(0);
    expect(summary.tradingDays).toBe(0);
    expect(summary.winRate).toBeNull();
    expect(summary.best).toBeNull();
    expect(summary.worst).toBeNull();
  });

  it('sums realized PnL across every row', () => {
    const summary = summarizePnl([
      { date: '2026-08-01', realizedPnlSol: 2.5, tradeCount: 3 },
      { date: '2026-08-02', realizedPnlSol: -1.5, tradeCount: 2 },
    ]);

    expect(summary.realizedSol).toBeCloseTo(1.0);
  });

  it('excludes days with no trades from the win rate', () => {
    // A month with one winning day and twenty untraded days is a 100% win
    // rate, not 5%. Counting quiet days as losses would make every real
    // month look catastrophic.
    const summary = summarizePnl([
      { date: '2026-08-01', realizedPnlSol: 5, tradeCount: 2 },
      { date: '2026-08-02', realizedPnlSol: 0, tradeCount: 0 },
      { date: '2026-08-03', realizedPnlSol: 0, tradeCount: 0 },
    ]);

    expect(summary.tradingDays).toBe(1);
    expect(summary.winDays).toBe(1);
    expect(summary.winRate).toBe(1);
  });

  it('counts a break-even trading day as neither a win nor a loss', () => {
    const summary = summarizePnl([
      { date: '2026-08-01', realizedPnlSol: 4, tradeCount: 1 },
      { date: '2026-08-02', realizedPnlSol: 0, tradeCount: 5 },
      { date: '2026-08-03', realizedPnlSol: -2, tradeCount: 1 },
    ]);

    expect(summary.tradingDays).toBe(3);
    expect(summary.winDays).toBe(1);
    expect(summary.lossDays).toBe(1);
    expect(summary.winRate).toBeCloseTo(1 / 3);
  });

  it('reports the best and worst trading day', () => {
    const summary = summarizePnl([
      { date: '2026-08-01', realizedPnlSol: 1, tradeCount: 1 },
      { date: '2026-08-02', realizedPnlSol: 6.1, tradeCount: 4 },
      { date: '2026-08-03', realizedPnlSol: -3.44, tradeCount: 2 },
    ]);

    expect(summary.best?.date).toBe('2026-08-02');
    expect(summary.worst?.date).toBe('2026-08-03');
  });

  it('breaks best/worst ties toward the earlier date', () => {
    const summary = summarizePnl([
      { date: '2026-08-05', realizedPnlSol: 3, tradeCount: 1 },
      { date: '2026-08-02', realizedPnlSol: 3, tradeCount: 1 },
    ]);

    expect(summary.best?.date).toBe('2026-08-02');
  });

  it('never reports a win rate of zero when there is simply no data', () => {
    // null and 0 must not render the same: "no trades yet" is not "lost every
    // single day". The embed in Task 9 branches on exactly this.
    expect(summarizePnl([{ date: '2026-08-01', realizedPnlSol: 0, tradeCount: 0 }]).winRate).toBeNull();
  });
});
```

- [x] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @cryptonix/core test -- summarize`
Expected: FAIL — cannot find module `./summarize`

- [x] **Step 3: Implement**

Create `packages/core/src/pnl/summarize.ts`:

```typescript
export interface DailyPnlRow {
  /** 'YYYY-MM-DD', as stored in pnl_daily.date */
  date: string;
  realizedPnlSol: number;
  tradeCount: number;
}

export interface PnlSummary {
  realizedSol: number;
  tradingDays: number;
  winDays: number;
  lossDays: number;
  /** winDays / tradingDays, or null when nothing was traded at all. */
  winRate: number | null;
  best: DailyPnlRow | null;
  worst: DailyPnlRow | null;
}

export function summarizePnl(rows: DailyPnlRow[]): PnlSummary {
  const realizedSol = rows.reduce((total, row) => total + row.realizedPnlSol, 0);

  // Only days that actually traded may influence win rate, best or worst.
  // Sorting by date first makes the tie-break (earlier date wins) fall out of
  // the strict > / < comparisons below without extra bookkeeping.
  const traded = rows.filter((row) => row.tradeCount > 0).sort((a, b) => a.date.localeCompare(b.date));

  let best: DailyPnlRow | null = null;
  let worst: DailyPnlRow | null = null;
  let winDays = 0;
  let lossDays = 0;

  for (const row of traded) {
    if (row.realizedPnlSol > 0) winDays++;
    else if (row.realizedPnlSol < 0) lossDays++;
    if (best === null || row.realizedPnlSol > best.realizedPnlSol) best = row;
    if (worst === null || row.realizedPnlSol < worst.realizedPnlSol) worst = row;
  }

  return {
    realizedSol,
    tradingDays: traded.length,
    winDays,
    lossDays,
    winRate: traded.length === 0 ? null : winDays / traded.length,
    best,
    worst,
  };
}
```

- [x] **Step 4: Run and confirm it passes**

Run: `pnpm --filter @cryptonix/core test -- summarize`
Expected: PASS — 7 tests

- [x] **Step 5: Commit**

```bash
git add packages/core/src/pnl/summarize.ts packages/core/src/pnl/summarize.test.ts
git commit -m "core: add PnL summary calculation"
```

---

### Task 4: core — calendar heatmap

Renders a month of daily PnL as a grid of coloured squares for the Discord embed. No image rendering and no native dependencies: Discord displays emoji at a uniform width, so a grid of squares aligns on every client.

**Files:**
- Create: `packages/core/src/pnl/heatmap.ts`
- Test: `packages/core/src/pnl/heatmap.test.ts`

**Interfaces:**
- Consumes: `DailyPnlRow` from Task 3.
- Produces:
  ```typescript
  export type HeatLevel = 0 | 1 | 2 | 3 | 4;
  export interface HeatmapCell { date: string | null; pnlSol: number; level: HeatLevel }
  export function buildHeatmapGrid(rows: DailyPnlRow[], month: string): HeatmapCell[][]
  export function renderHeatmap(grid: HeatmapCell[][]): string
  export const HEATMAP_LEGEND: string
  ```
  Task 9's embed consumes all four.

**Design notes, each one load-bearing:**
- `month` is `'YYYY-MM'`. All date maths uses **UTC** (`Date.UTC`, `getUTCDay`, `getUTCDate`). Local-time construction shifts the whole calendar by a day for anyone west of UTC.
- Weeks are rows, Monday-first: `(date.getUTCDay() + 6) % 7`.
- `date: null` marks a padding cell — a slot in the first or last week that belongs to a neighbouring month. Padding renders as ⬛ so it reads as "not this month", distinct from ⬜ "traded nothing".
- Levels are **relative to the month being shown**, scaled against that month's own best and worst day. An absolute SOL threshold would render a quiet month as uniformly blank and a volatile one as uniformly saturated.
- **No weekday header row.** The mockup showed `Mo Tu We…`, but emoji cells are roughly double the width of Latin letters, so such a header cannot line up on any client. The month name and a Monday-first note go in the embed instead (Task 9).

| Level | Meaning | Glyph |
|---|---|---|
| 0 | No trades that day | ⬜ |
| 1 | Loss, at least half as deep as the month's worst day | 🟥 |
| 2 | Shallower loss | 🟧 |
| 3 | Gain, under half the month's best day | 🟩 |
| 4 | Gain, at least half the month's best day | 🟢 |
| — | Day outside this month (padding) | ⬛ |

- [x] **Step 1: Write the failing tests**

Create `packages/core/src/pnl/heatmap.test.ts`. The calendar facts asserted here are real: 2026-08-01 falls on a Saturday (Monday-first index 5) and August has 31 days, so the grid is 5 padding cells + 31 days = 36 slots, rounded up to 6 rows of 7.

```typescript
import { describe, it, expect } from 'vitest';
import { buildHeatmapGrid, renderHeatmap } from './heatmap';

describe('buildHeatmapGrid', () => {
  it('pads the first week so day 1 lands on its real weekday', () => {
    // 2026-08-01 is a Saturday. Monday-first, that is index 5, so five
    // padding cells precede it.
    const grid = buildHeatmapGrid([], '2026-08');

    expect(grid[0]).toHaveLength(7);
    expect(grid[0].slice(0, 5).every((cell) => cell.date === null)).toBe(true);
    expect(grid[0][5].date).toBe('2026-08-01');
  });

  it('covers every day of the month and pads the final week to seven', () => {
    const grid = buildHeatmapGrid([], '2026-08');
    const cells = grid.flat();
    const realDays = cells.filter((cell) => cell.date !== null);

    expect(realDays).toHaveLength(31);
    expect(realDays[30].date).toBe('2026-08-31');
    expect(cells).toHaveLength(42); // 6 rows x 7
    expect(grid.every((week) => week.length === 7)).toBe(true);
  });

  it('handles a month that starts on a Sunday', () => {
    // 2026-02-01 is a Sunday: Monday-first index 6, so six padding cells,
    // and 28 days fits in exactly 5 rows.
    const grid = buildHeatmapGrid([], '2026-02');

    expect(grid[0][6].date).toBe('2026-02-01');
    expect(grid).toHaveLength(5);
  });

  it('marks untraded days as level 0', () => {
    const grid = buildHeatmapGrid([{ date: '2026-08-03', realizedPnlSol: 0, tradeCount: 0 }], '2026-08');
    const cell = grid.flat().find((c) => c.date === '2026-08-03');

    expect(cell?.level).toBe(0);
  });

  it('scales levels against the month\'s own best and worst day', () => {
    const grid = buildHeatmapGrid(
      [
        { date: '2026-08-03', realizedPnlSol: 10, tradeCount: 2 },  // best -> 4
        { date: '2026-08-04', realizedPnlSol: 2, tradeCount: 1 },   // 20% of best -> 3
        { date: '2026-08-05', realizedPnlSol: -8, tradeCount: 3 },  // worst -> 1
        { date: '2026-08-06', realizedPnlSol: -1, tradeCount: 1 },  // shallow loss -> 2
      ],
      '2026-08'
    );
    const byDate = Object.fromEntries(grid.flat().filter((c) => c.date).map((c) => [c.date, c.level]));

    expect(byDate['2026-08-03']).toBe(4);
    expect(byDate['2026-08-04']).toBe(3);
    expect(byDate['2026-08-05']).toBe(1);
    expect(byDate['2026-08-06']).toBe(2);
  });

  it('ignores rows belonging to a different month', () => {
    const grid = buildHeatmapGrid([{ date: '2026-07-30', realizedPnlSol: 99, tradeCount: 9 }], '2026-08');

    expect(grid.flat().every((cell) => cell.level === 0)).toBe(true);
  });
});

describe('renderHeatmap', () => {
  it('renders one line per week using the level glyphs', () => {
    const grid = buildHeatmapGrid([{ date: '2026-08-01', realizedPnlSol: 5, tradeCount: 2 }], '2026-08');

    const lines = renderHeatmap(grid).split('\n');

    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe('⬛⬛⬛⬛⬛🟢⬜');
  });
});
```

- [x] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @cryptonix/core test -- heatmap`
Expected: FAIL — cannot find module `./heatmap`

- [x] **Step 3: Implement**

Create `packages/core/src/pnl/heatmap.ts`:

```typescript
import type { DailyPnlRow } from './summarize.js';

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export interface HeatmapCell {
  /** 'YYYY-MM-DD', or null for a padding slot outside the rendered month. */
  date: string | null;
  pnlSol: number;
  level: HeatLevel;
}

const GLYPHS: Record<HeatLevel, string> = {
  0: '⬜',
  1: '🟥',
  2: '🟧',
  3: '🟩',
  4: '🟢',
};
const PADDING_GLYPH = '⬛';

export const HEATMAP_LEGEND =
  '⬜ no trades · 🟧 loss · 🟥 big loss · 🟩 gain · 🟢 big gain · ⬛ other month';

/**
 * Levels are relative to this month's own extremes, not to absolute SOL. A
 * quiet month would otherwise render as a uniformly blank grid and a volatile
 * one as uniformly saturated, which tells the reader nothing either way.
 */
function levelFor(pnlSol: number, traded: boolean, best: number, worst: number): HeatLevel {
  if (!traded) return 0;
  if (pnlSol > 0) return best > 0 && pnlSol >= best / 2 ? 4 : 3;
  if (pnlSol < 0) return worst < 0 && pnlSol <= worst / 2 ? 1 : 2;
  return 0; // traded, but exactly break-even
}

export function buildHeatmapGrid(rows: DailyPnlRow[], month: string): HeatmapCell[][] {
  const [year, monthIndex] = month.split('-').map(Number);

  // Every date calculation is UTC. Building these from local time shifts the
  // whole calendar by a day for anyone in a negative-offset timezone.
  const firstOfMonth = new Date(Date.UTC(year, monthIndex - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  const leadingPad = (firstOfMonth.getUTCDay() + 6) % 7; // Monday-first

  const byDate = new Map(rows.filter((row) => row.date.startsWith(`${month}-`)).map((row) => [row.date, row]));
  const monthRows = [...byDate.values()].filter((row) => row.tradeCount > 0);
  const best = monthRows.reduce((max, row) => Math.max(max, row.realizedPnlSol), 0);
  const worst = monthRows.reduce((min, row) => Math.min(min, row.realizedPnlSol), 0);

  const cells: HeatmapCell[] = [];
  for (let i = 0; i < leadingPad; i++) cells.push({ date: null, pnlSol: 0, level: 0 });

  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    const row = byDate.get(date);
    cells.push({
      date,
      pnlSol: row?.realizedPnlSol ?? 0,
      level: levelFor(row?.realizedPnlSol ?? 0, (row?.tradeCount ?? 0) > 0, best, worst),
    });
  }

  while (cells.length % 7 !== 0) cells.push({ date: null, pnlSol: 0, level: 0 });

  const grid: HeatmapCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) grid.push(cells.slice(i, i + 7));
  return grid;
}

export function renderHeatmap(grid: HeatmapCell[][]): string {
  return grid
    .map((week) => week.map((cell) => (cell.date === null ? PADDING_GLYPH : GLYPHS[cell.level])).join(''))
    .join('\n');
}
```

- [x] **Step 4: Run and confirm it passes**

Run: `pnpm --filter @cryptonix/core test -- heatmap`
Expected: PASS — 7 tests

- [x] **Step 5: Export both modules from the barrel**

Add to `packages/core/src/index.ts`:

```typescript
export * from './pnl/summarize.js';
export * from './pnl/heatmap.js';
```

- [x] **Step 6: Build and commit**

Run: `pnpm --filter @cryptonix/core build && pnpm --filter @cryptonix/core test`
Expected: build succeeds, all core tests pass

```bash
git add packages/core/src/pnl/heatmap.ts packages/core/src/pnl/heatmap.test.ts packages/core/src/index.ts
git commit -m "core: add calendar heatmap grid and renderer"
```

---

### Task 5: `apps/discord-bot` — scaffold and env

**Files:**
- Create: `apps/discord-bot/package.json`
- Create: `apps/discord-bot/tsconfig.json`
- Create: `apps/discord-bot/src/env.ts`
- Test: `apps/discord-bot/src/env.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `env` — `{ discordToken, discordClientId, discordGuildId, alertChannelId, engineHttpUrl, engineWsUrl }`, all `string`. Tasks 6–11 read it.

**On the duplicated env loader — a deliberate call, not an oversight.** `apps/engine/src/env.ts` walks up from `cwd` to find the repo-root `.env`, because `pnpm --filter … dev` runs with `cwd` set to the app directory and a bare `dotenv/config` misses it. The bot has exactly the same problem, and this plan copies those ~18 lines rather than extracting them. Hoisting a runtime helper into `packages/config` would mean giving that tsconfig-only package a `src/`, a build step, and exports — real structure to carry 18 lines. Each copy carries a comment pointing at its twin so they are fixed together.

- [x] **Step 1: Create `apps/discord-bot/package.json`**

```json
{
  "name": "@cryptonix/discord-bot",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "start": "node dist/index.js",
    "register-commands": "tsx src/commands/registry.ts"
  },
  "dependencies": {
    "@cryptonix/core": "workspace:*",
    "discord.js": "^14.25.1",
    "dotenv": "^16.4.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@cryptonix/config": "workspace:*",
    "@types/ws": "^8.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [x] **Step 2: Create `apps/discord-bot/tsconfig.json`**

Matches every other package — `rootDir`/`outDir` live here, never in the shared base, and tests are excluded from the build:

```json
{
  "extends": "@cryptonix/config/tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [x] **Step 3: Install**

Run: `pnpm install`
Expected: `@cryptonix/discord-bot` is picked up by the `apps/*` workspace glob; discord.js resolves at 14.25.x

- [x] **Step 4: Write the failing test**

Create `apps/discord-bot/src/env.test.ts`. `env.ts` reads `process.env` at import time, so each test imports it fresh with `vi.resetModules()`.

**`dotenv` is mocked out, and that is essential.** `env.ts` calls `loadEnvFile()`, which finds the repo-root `.env` — the real one, which after Step 7 contains every variable these tests deliberately remove. `dotenv` would helpfully put the deleted variable back and the missing-variable test would pass a value it was supposed to be missing. Mocking `config` to a no-op keeps the test about `required()` and nothing else:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Neutralise real .env loading — see note above.
vi.mock('dotenv', () => ({ config: vi.fn() }));

const REQUIRED = {
  DISCORD_TOKEN: 'token1',
  DISCORD_CLIENT_ID: 'client1',
  DISCORD_GUILD_ID: 'guild1',
  DISCORD_ALERT_CHANNEL_ID: 'channel1',
  ENGINE_HTTP_URL: 'http://localhost:8787',
  ENGINE_WS_URL: 'ws://localhost:8787/ws',
};

describe('env', () => {
  const original = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    for (const [key, value] of Object.entries(REQUIRED)) process.env[key] = value;
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('reads every required variable', async () => {
    const { env } = await import('./env');

    expect(env.discordToken).toBe('token1');
    expect(env.alertChannelId).toBe('channel1');
    expect(env.engineWsUrl).toBe('ws://localhost:8787/ws');
  });

  it('throws a named error when a variable is missing', async () => {
    // Failing loudly at startup beats a bot that logs in fine and then
    // silently posts nothing because the channel id was undefined.
    delete process.env.DISCORD_ALERT_CHANNEL_ID;

    await expect(import('./env')).rejects.toThrow('DISCORD_ALERT_CHANNEL_ID');
  });
});
```

- [x] **Step 5: Run and confirm it fails**

Run: `pnpm --filter @cryptonix/discord-bot test`
Expected: FAIL — cannot find module `./env`

- [x] **Step 6: Implement**

Create `apps/discord-bot/src/env.ts`:

```typescript
import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Twin of apps/engine/src/env.ts — keep both in step. `pnpm --filter
// @cryptonix/discord-bot dev` runs with cwd set to apps/discord-bot, but .env
// lives at the repo root, and a bare `dotenv/config` only looks in cwd. Walk
// up to the nearest .env instead.
function loadEnvFile() {
  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth++) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) {
      config({ path: candidate });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  config();
}

loadEnvFile();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  discordToken: required('DISCORD_TOKEN'),
  discordClientId: required('DISCORD_CLIENT_ID'),
  discordGuildId: required('DISCORD_GUILD_ID'),
  alertChannelId: required('DISCORD_ALERT_CHANNEL_ID'),
  engineHttpUrl: required('ENGINE_HTTP_URL'),
  engineWsUrl: required('ENGINE_WS_URL'),
};
```

- [x] **Step 7: Extend `.env.example`**

Append to `.env.example` at the repo root (placeholders only — never real values):

```
DISCORD_TOKEN=your-discord-bot-token-here
DISCORD_CLIENT_ID=your-discord-application-id
DISCORD_GUILD_ID=your-discord-server-id
DISCORD_ALERT_CHANNEL_ID=your-alerts-channel-id
ENGINE_HTTP_URL=http://localhost:8787
ENGINE_WS_URL=ws://localhost:8787/ws
```

Then copy those six lines into your real `.env` and fill in the values from the Prerequisites section. `.env` is gitignored; keep it that way.

- [x] **Step 8: Run and confirm it passes**

Run: `pnpm --filter @cryptonix/discord-bot test`
Expected: PASS — 2 tests

- [x] **Step 9: Commit**

```bash
git add apps/discord-bot .env.example
git commit -m "discord-bot: scaffold app and env config"
```

---

### Task 6: `apps/discord-bot` — engine REST client

The single place the bot talks HTTP to the engine. Every command handler goes through it, so error shape is decided once, here.

**Files:**
- Create: `apps/discord-bot/src/engine/client.ts`
- Test: `apps/discord-bot/src/engine/client.test.ts`

**Interfaces:**
- Consumes: `DELETE /wallets/:id` from Task 2; `DailyPnlRow` from Task 3.
- Produces:
  ```typescript
  export interface Wallet {
    id: number; address: string; label: string; isMine: boolean;
    heliusWebhookId: string | null; backfillStatus: string; addedAt: string;
  }
  export class EngineError extends Error { constructor(message: string, readonly status: number) }
  export class EngineClient {
    constructor(baseUrl: string)
    listWallets(): Promise<Wallet[]>
    trackWallet(address: string, label: string, isMine: boolean): Promise<Wallet>
    untrackWallet(id: number): Promise<void>
    getPnl(walletId: number): Promise<DailyPnlRow[]>
  }
  ```
  Tasks 10 and 11 consume these.

- [x] **Step 1: Write the failing tests**

Create `apps/discord-bot/src/engine/client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EngineClient, EngineError } from './client';

describe('EngineClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('lists wallets', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ id: 1, address: 'Addr1', label: 'Me' }],
    });

    const wallets = await new EngineClient('http://engine:8787').listWallets();

    expect(wallets).toHaveLength(1);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('http://engine:8787/wallets');
  });

  it('tracks a wallet with the right body', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 7, address: 'Addr1', label: 'Whale' }),
    });

    const wallet = await new EngineClient('http://engine:8787').trackWallet('Addr1', 'Whale', false);

    expect(wallet.id).toBe(7);
    const [, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ address: 'Addr1', label: 'Whale', isMine: false });
  });

  it('untracks a wallet and tolerates the 204 empty body', async () => {
    // DELETE /wallets/:id answers 204 with no body. Calling res.json() on that
    // throws; the client must not.
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error('no body to parse');
      },
    });

    await expect(new EngineClient('http://engine:8787').untrackWallet(7)).resolves.toBeUndefined();
  });

  it('raises EngineError carrying the status code', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'wallet not found',
    });

    const error = await new EngineClient('http://engine:8787').getPnl(99).catch((e) => e);

    expect(error).toBeInstanceOf(EngineError);
    expect(error.status).toBe(404);
  });

  it('surfaces a connection failure as EngineError with status 0', async () => {
    // The engine being down is the common case in practice (it is a separate
    // process). Command handlers branch on EngineError, so a raw TypeError
    // from fetch must not escape.
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError('fetch failed'));

    const error = await new EngineClient('http://engine:8787').listWallets().catch((e) => e);

    expect(error).toBeInstanceOf(EngineError);
    expect(error.status).toBe(0);
  });
});
```

- [x] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @cryptonix/discord-bot test -- client`
Expected: FAIL — cannot find module `./client`

- [x] **Step 3: Implement**

Create `apps/discord-bot/src/engine/client.ts`:

```typescript
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
}
```

- [x] **Step 4: Run and confirm it passes**

Run: `pnpm --filter @cryptonix/discord-bot test -- client`
Expected: PASS — 5 tests

- [x] **Step 5: Commit**

```bash
git add apps/discord-bot/src/engine/client.ts apps/discord-bot/src/engine/client.test.ts
git commit -m "discord-bot: add engine REST client"
```

---

### Task 7: `apps/discord-bot` — alert stream

Subscribes to the engine's WebSocket and survives it going away. The engine restarts (deploys, crashes, `pnpm dev` reloads); a bot that gives up on the first disconnect stops alerting silently, which is worse than crashing (spec §9).

**Files:**
- Create: `apps/discord-bot/src/engine/alert-stream.ts`
- Test: `apps/discord-bot/src/engine/alert-stream.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface AlertEvent { type: string; refId: number; payload: unknown }
  export interface AlertSocket {
    on(event: string, handler: (...args: any[]) => void): void;
    close(): void;
  }
  export interface AlertStreamOptions {
    url: string;
    createSocket?: (url: string) => AlertSocket;
    schedule?: (fn: () => void, ms: number) => void;
    initialDelayMs?: number;
    maxDelayMs?: number;
  }
  export class AlertStream {
    constructor(options: AlertStreamOptions)
    onAlert(handler: (alert: AlertEvent) => void): void
    start(): void
    stop(): void
  }
  ```
  `AlertEvent` matches what `apps/engine/src/api/alert-bus.ts` publishes verbatim. Task 11 consumes this class.

- [x] **Step 1: Write the failing tests**

Create `apps/discord-bot/src/engine/alert-stream.test.ts`. The fake socket lets the test drive `open`/`message`/`close` by hand, so nothing here touches a real network:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { AlertStream, type AlertSocket } from './alert-stream';

class FakeSocket implements AlertSocket {
  handlers: Record<string, ((...args: any[]) => void)[]> = {};
  closed = false;

  on(event: string, handler: (...args: any[]) => void) {
    (this.handlers[event] ??= []).push(handler);
  }
  close() {
    this.closed = true;
  }
  emit(event: string, ...args: any[]) {
    for (const handler of this.handlers[event] ?? []) handler(...args);
  }
}

function build() {
  const sockets: FakeSocket[] = [];
  const delays: number[] = [];
  const pending: (() => void)[] = [];
  const stream = new AlertStream({
    url: 'ws://engine/ws',
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    schedule: (fn, ms) => {
      delays.push(ms);
      pending.push(fn);
    },
    initialDelayMs: 100,
    maxDelayMs: 800,
  });
  return { stream, sockets, delays, runPending: () => pending.shift()?.() };
}

describe('AlertStream', () => {
  it('forwards a parsed alert to the handler', () => {
    const { stream, sockets } = build();
    const received: any[] = [];
    stream.onAlert((alert) => received.push(alert));
    stream.start();

    sockets[0].emit('message', JSON.stringify({ type: 'wallet_buy', refId: 3, payload: { mint: 'Mint1' } }));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('wallet_buy');
    expect(received[0].refId).toBe(3);
  });

  it('ignores a malformed message instead of throwing', () => {
    // One bad frame must not take down the alert pipeline. The engine's own
    // ws.ts makes the same guarantee on its side.
    const { stream, sockets } = build();
    const received: any[] = [];
    stream.onAlert((alert) => received.push(alert));
    stream.start();

    expect(() => sockets[0].emit('message', 'not json at all')).not.toThrow();
    expect(received).toHaveLength(0);
  });

  it('ignores a JSON message that is not an alert', () => {
    const { stream, sockets } = build();
    const received: any[] = [];
    stream.onAlert((alert) => received.push(alert));
    stream.start();

    sockets[0].emit('message', JSON.stringify({ hello: 'world' }));

    expect(received).toHaveLength(0);
  });

  it('reconnects after a close, backing off each time', () => {
    const { stream, sockets, delays, runPending } = build();
    stream.start();

    sockets[0].emit('close');
    runPending();
    expect(sockets).toHaveLength(2);

    sockets[1].emit('close');
    runPending();
    expect(sockets).toHaveLength(3);

    expect(delays).toEqual([100, 200]);
  });

  it('caps the backoff delay', () => {
    const { stream, sockets, delays, runPending } = build();
    stream.start();

    for (let i = 0; i < 6; i++) {
      sockets[sockets.length - 1].emit('close');
      runPending();
    }

    expect(Math.max(...delays)).toBe(800);
  });

  it('resets the backoff once a connection succeeds', () => {
    // Without this, a bot that has been up for days and briefly blips would
    // wait the full capped delay before reconnecting.
    const { stream, sockets, delays, runPending } = build();
    stream.start();

    sockets[0].emit('close');
    runPending();
    sockets[1].emit('open');
    sockets[1].emit('close');
    runPending();

    expect(delays).toEqual([100, 100]);
  });

  it('stops reconnecting after stop()', () => {
    const { stream, sockets, runPending } = build();
    stream.start();
    stream.stop();

    sockets[0].emit('close');
    runPending();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].closed).toBe(true);
  });
});
```

- [x] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @cryptonix/discord-bot test -- alert-stream`
Expected: FAIL — cannot find module `./alert-stream`

- [x] **Step 3: Implement**

Create `apps/discord-bot/src/engine/alert-stream.ts`:

```typescript
import WebSocket from 'ws';

/** Exactly what apps/engine/src/api/alert-bus.ts publishes over /ws. */
export interface AlertEvent {
  type: string;
  refId: number;
  payload: unknown;
}

/** The slice of a WebSocket this class uses, so tests can supply a fake. */
export interface AlertSocket {
  on(event: string, handler: (...args: any[]) => void): void;
  close(): void;
}

export interface AlertStreamOptions {
  url: string;
  createSocket?: (url: string) => AlertSocket;
  schedule?: (fn: () => void, ms: number) => void;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

function isAlertEvent(value: unknown): value is AlertEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AlertEvent).type === 'string' &&
    typeof (value as AlertEvent).refId === 'number'
  );
}

export class AlertStream {
  private readonly createSocket: (url: string) => AlertSocket;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;

  private handlers: ((alert: AlertEvent) => void)[] = [];
  private socket: AlertSocket | null = null;
  private delayMs: number;
  private stopped = false;

  constructor(private options: AlertStreamOptions) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as AlertSocket);
    this.schedule = options.schedule ?? ((fn, ms) => { setTimeout(fn, ms); });
    this.initialDelayMs = options.initialDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.delayMs = this.initialDelayMs;
  }

  onAlert(handler: (alert: AlertEvent) => void) {
    this.handlers.push(handler);
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
  }

  private connect() {
    const socket = this.createSocket(this.options.url);
    this.socket = socket;

    // A successful connection resets the backoff. Without this, a long-lived
    // bot that blips once would then wait the full capped delay to come back.
    socket.on('open', () => {
      this.delayMs = this.initialDelayMs;
    });

    socket.on('message', (data: unknown) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        console.error('alert stream: ignoring unparseable message');
        return;
      }
      if (!isAlertEvent(parsed)) return;
      for (const handler of this.handlers) handler(parsed);
    });

    // 'error' fires alongside 'close' on a failed connection; reconnecting is
    // driven off 'close' alone so one failure does not schedule two attempts.
    socket.on('error', (err: Error) => {
      console.error('alert stream: socket error', err.message);
    });

    socket.on('close', () => {
      if (this.stopped) return;
      const delay = this.delayMs;
      this.delayMs = Math.min(this.delayMs * 2, this.maxDelayMs);
      this.schedule(() => {
        if (!this.stopped) this.connect();
      }, delay);
    });
  }
}
```

- [x] **Step 4: Run and confirm it passes**

Run: `pnpm --filter @cryptonix/discord-bot test -- alert-stream`
Expected: PASS — 7 tests

- [x] **Step 5: Commit**

```bash
git add apps/discord-bot/src/engine/alert-stream.ts apps/discord-bot/src/engine/alert-stream.test.ts
git commit -m "discord-bot: add reconnecting alert stream"
```

---

### Task 8: `apps/discord-bot` — wallet trade embed

**Files:**
- Create: `apps/discord-bot/src/embeds/wallet-buy.ts`
- Test: `apps/discord-bot/src/embeds/wallet-buy.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface WalletAlertPayload {
    walletId: number; walletLabel: string; mint: string;
    side: 'buy' | 'sell'; solAmount: number; tokenAmount: number; axiomLink: string;
  }
  export function isWalletAlertPayload(value: unknown): value is WalletAlertPayload
  export function buildWalletTradeMessage(payload: WalletAlertPayload): {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
  }
  ```
  Task 11 consumes both. `WalletAlertPayload` is copied field-for-field from what `apps/engine/src/monitors/wallet-monitor.ts` writes into `alerts.payload`.

**Why a type guard.** The payload arrives as `unknown` off a JSON socket. Phase 3 adds `tweet` and `new_coin` alerts to the same stream (spec §11), so the bot must be able to look at a payload and decline it rather than render `undefined` into a live channel.

**Sells too, not just buys.** Spec §5.2 names the buy alert, but the engine already publishes `wallet_sell` from the same code path. Rendering only buys would drop half the stream on the floor; the embed colours and labels the two differently.

- [x] **Step 1: Write the failing tests**

Create `apps/discord-bot/src/embeds/wallet-buy.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildWalletTradeMessage, isWalletAlertPayload } from './wallet-buy';

const payload = {
  walletId: 1,
  walletLabel: 'Whale One',
  mint: 'So11111111111111111111111111111111111111112',
  side: 'buy' as const,
  solAmount: 2.5,
  tokenAmount: 1_250_000,
  axiomLink: 'https://axiom.trade/t/So11111111111111111111111111111111111111112',
};

describe('isWalletAlertPayload', () => {
  it('accepts a well-formed payload', () => {
    expect(isWalletAlertPayload(payload)).toBe(true);
  });

  it('rejects payloads from other alert types', () => {
    // Phase 3 puts tweet and new-coin alerts on this same socket. Rendering
    // one of those as a trade would post a wall of "undefined" to a live channel.
    expect(isWalletAlertPayload({ tweetId: '123', text: 'gm' })).toBe(false);
    expect(isWalletAlertPayload(null)).toBe(false);
    expect(isWalletAlertPayload({ ...payload, side: 'sideways' })).toBe(false);
  });
});

describe('buildWalletTradeMessage', () => {
  it('names the wallet and the amounts in the embed', () => {
    const { embeds } = buildWalletTradeMessage(payload);
    const data = embeds[0].toJSON();

    expect(data.title).toContain('Whale One');
    expect(JSON.stringify(data)).toContain('2.5');
  });

  it('attaches an Axiom link button pointing at the mint', () => {
    const { components } = buildWalletTradeMessage(payload);
    const button = components[0].toJSON().components[0] as { url?: string; style: number };

    expect(button.url).toBe(payload.axiomLink);
    expect(button.style).toBe(5); // ButtonStyle.Link
  });

  it('colours buys and sells differently', () => {
    const buy = buildWalletTradeMessage(payload).embeds[0].toJSON();
    const sell = buildWalletTradeMessage({ ...payload, side: 'sell' }).embeds[0].toJSON();

    expect(buy.color).not.toBe(sell.color);
    expect(sell.title).toContain('Sell');
  });
});
```

- [x] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @cryptonix/discord-bot test -- wallet-buy`
Expected: FAIL — cannot find module `./wallet-buy`

- [x] **Step 3: Implement**

Create `apps/discord-bot/src/embeds/wallet-buy.ts`:

```typescript
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';

/** Field-for-field the object apps/engine/src/monitors/wallet-monitor.ts stores in alerts.payload. */
export interface WalletAlertPayload {
  walletId: number;
  walletLabel: string;
  mint: string;
  side: 'buy' | 'sell';
  solAmount: number;
  tokenAmount: number;
  axiomLink: string;
}

const BUY_COLOR = 0x22c55e;
const SELL_COLOR = 0xef4444;

/**
 * Payloads arrive as `unknown` off a JSON socket, and Phase 3 will put tweet
 * and new-coin alerts on that same socket. Anything that is not a wallet trade
 * gets declined here rather than rendered into a live channel.
 */
export function isWalletAlertPayload(value: unknown): value is WalletAlertPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Partial<WalletAlertPayload>;
  return (
    typeof p.walletLabel === 'string' &&
    typeof p.mint === 'string' &&
    (p.side === 'buy' || p.side === 'sell') &&
    typeof p.solAmount === 'number' &&
    typeof p.tokenAmount === 'number' &&
    typeof p.axiomLink === 'string'
  );
}

function shortMint(mint: string): string {
  return mint.length <= 12 ? mint : `${mint.slice(0, 6)}…${mint.slice(-4)}`;
}

export function buildWalletTradeMessage(payload: WalletAlertPayload) {
  const isBuy = payload.side === 'buy';

  const embed = new EmbedBuilder()
    .setColor(isBuy ? BUY_COLOR : SELL_COLOR)
    .setTitle(`${isBuy ? '🟢 Buy' : '🔴 Sell'} — ${payload.walletLabel}`)
    .addFields(
      { name: 'SOL', value: `${payload.solAmount.toFixed(4)} SOL`, inline: true },
      { name: 'Tokens', value: payload.tokenAmount.toLocaleString('en-US'), inline: true },
      { name: 'Mint', value: `\`${shortMint(payload.mint)}\``, inline: true }
    )
    .setTimestamp(new Date());

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel('Open on Axiom').setURL(payload.axiomLink).setStyle(ButtonStyle.Link)
  );

  return { embeds: [embed], components: [row] };
}
```

- [x] **Step 4: Run and confirm it passes**

Run: `pnpm --filter @cryptonix/discord-bot test -- wallet-buy`
Expected: PASS — 5 tests

- [x] **Step 5: Commit**

```bash
git add apps/discord-bot/src/embeds/wallet-buy.ts apps/discord-bot/src/embeds/wallet-buy.test.ts
git commit -m "discord-bot: add wallet trade embed with Axiom link button"
```

---

### Task 9: `apps/discord-bot` — PnL embed

**Files:**
- Create: `apps/discord-bot/src/embeds/pnl.ts`
- Test: `apps/discord-bot/src/embeds/pnl.test.ts`

**Interfaces:**
- Consumes: `summarizePnl`, `buildHeatmapGrid`, `renderHeatmap`, `HEATMAP_LEGEND`, `DailyPnlRow` — all from `@cryptonix/core` (Tasks 3–4).
- Produces: `buildPnlEmbed(options: { walletLabel: string; month: string; rows: DailyPnlRow[] }): EmbedBuilder`. Task 10 consumes it.

- [x] **Step 1: Write the failing tests**

Create `apps/discord-bot/src/embeds/pnl.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildPnlEmbed } from './pnl';

const rows = [
  { date: '2026-08-01', realizedPnlSol: 6.1, tradeCount: 4 },
  { date: '2026-08-02', realizedPnlSol: -3.44, tradeCount: 2 },
  { date: '2026-08-03', realizedPnlSol: 1.2, tradeCount: 1 },
];

describe('buildPnlEmbed', () => {
  it('titles the embed with the wallet and month', () => {
    const data = buildPnlEmbed({ walletLabel: 'Me', month: '2026-08', rows }).toJSON();

    expect(data.title).toContain('Me');
    expect(data.title).toContain('2026-08');
  });

  it('shows realized PnL with an explicit sign', () => {
    const data = buildPnlEmbed({ walletLabel: 'Me', month: '2026-08', rows }).toJSON();
    const realized = data.fields?.find((f) => f.name.includes('Realized'));

    expect(realized?.value).toContain('+3.86');
  });

  it('shows a negative total without a stray plus sign', () => {
    const data = buildPnlEmbed({
      walletLabel: 'Me',
      month: '2026-08',
      rows: [{ date: '2026-08-01', realizedPnlSol: -2.5, tradeCount: 1 }],
    }).toJSON();
    const realized = data.fields?.find((f) => f.name.includes('Realized'));

    expect(realized?.value).toContain('-2.5000');
    expect(realized?.value).not.toContain('+');
  });

  it('renders the heatmap grid in the description', () => {
    const data = buildPnlEmbed({ walletLabel: 'Me', month: '2026-08', rows }).toJSON();

    expect(data.description).toContain('🟢');
    expect(data.description).toContain('⬛'); // padding for a month not starting on Monday
  });

  it('renders an em dash rather than 0% when nothing was traded', () => {
    // summarizePnl returns null for win rate on an empty month. Printing "0%"
    // would read as "lost every trade" instead of "no trades".
    const data = buildPnlEmbed({ walletLabel: 'Me', month: '2026-08', rows: [] }).toJSON();
    const winRate = data.fields?.find((f) => f.name.includes('Win rate'));

    expect(winRate?.value).toBe('—');
  });

  it('names the best and worst day', () => {
    const data = buildPnlEmbed({ walletLabel: 'Me', month: '2026-08', rows }).toJSON();
    const best = data.fields?.find((f) => f.name.includes('Best'));
    const worst = data.fields?.find((f) => f.name.includes('Worst'));

    expect(best?.value).toContain('2026-08-01');
    expect(worst?.value).toContain('2026-08-02');
  });
});
```

- [x] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @cryptonix/discord-bot test -- pnl`
Expected: FAIL — cannot find module `./pnl`

- [x] **Step 3: Implement**

Create `apps/discord-bot/src/embeds/pnl.ts`:

```typescript
import { EmbedBuilder } from 'discord.js';
import {
  buildHeatmapGrid,
  renderHeatmap,
  summarizePnl,
  HEATMAP_LEGEND,
  type DailyPnlRow,
} from '@cryptonix/core';

const POSITIVE_COLOR = 0x22c55e;
const NEGATIVE_COLOR = 0xef4444;
const NEUTRAL_COLOR = 0x64748b;

function signedSol(value: number): string {
  // toFixed already carries the minus sign; only gains need one added.
  return `${value > 0 ? '+' : ''}${value.toFixed(4)} SOL`;
}

export function buildPnlEmbed(options: { walletLabel: string; month: string; rows: DailyPnlRow[] }): EmbedBuilder {
  const { walletLabel, month, rows } = options;
  const summary = summarizePnl(rows);
  const grid = buildHeatmapGrid(rows, month);

  const color =
    summary.realizedSol > 0 ? POSITIVE_COLOR : summary.realizedSol < 0 ? NEGATIVE_COLOR : NEUTRAL_COLOR;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`PnL — ${walletLabel} — ${month}`)
    .setDescription(renderHeatmap(grid))
    .addFields(
      { name: 'Realized', value: signedSol(summary.realizedSol), inline: true },
      {
        name: 'Win rate',
        // null means "no trading days at all". Rendering that as 0% would
        // claim every day lost, which is a different and much worse statement.
        value:
          summary.winRate === null
            ? '—'
            : `${Math.round(summary.winRate * 100)}%  (${summary.winDays}W / ${summary.lossDays}L)`,
        inline: true,
      },
      { name: 'Trading days', value: String(summary.tradingDays), inline: true },
      {
        name: 'Best',
        value: summary.best ? `${summary.best.date}  ${signedSol(summary.best.realizedPnlSol)}` : '—',
        inline: true,
      },
      {
        name: 'Worst',
        value: summary.worst ? `${summary.worst.date}  ${signedSol(summary.worst.realizedPnlSol)}` : '—',
        inline: true,
      }
    )
    .setFooter({ text: `Weeks run Monday→Sunday · ${HEATMAP_LEGEND}` });
}
```

- [x] **Step 4: Run and confirm it passes**

Run: `pnpm --filter @cryptonix/discord-bot test -- pnl`
Expected: PASS — 6 tests

- [x] **Step 5: Commit**

```bash
git add apps/discord-bot/src/embeds/pnl.ts apps/discord-bot/src/embeds/pnl.test.ts
git commit -m "discord-bot: add PnL embed with calendar heatmap"
```

---

### Task 10: `apps/discord-bot` — slash commands

**Files:**
- Create: `apps/discord-bot/src/commands/types.ts`
- Create: `apps/discord-bot/src/commands/track.ts`
- Create: `apps/discord-bot/src/commands/untrack.ts`
- Create: `apps/discord-bot/src/commands/pnl.ts`
- Create: `apps/discord-bot/src/commands/registry.ts`
- Test: `apps/discord-bot/src/commands/commands.test.ts`

**Interfaces:**
- Consumes: `EngineClient`, `EngineError` (Task 6); `buildPnlEmbed` (Task 9).
- Produces:
  ```typescript
  export interface CommandDeps { engine: EngineClient }
  export interface BotCommand {
    data: { name: string; toJSON(): unknown };
    execute(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void>;
  }
  export const commands: BotCommand[]
  export async function registerCommands(token: string, clientId: string, guildId: string): Promise<void>
  ```
  Task 11 consumes `commands`.

**Behaviour decisions:**
- `/track wallet address:<addr> [label:<text>] [mine:<bool>]` — the engine rejects a missing label with 400, so an omitted label defaults to a shortened address rather than failing.
- `/untrack wallet address:<addr>` — resolves address → id via `listWallets()`, since the engine keys deletion by id and a human types an address.
- `/pnl [wallet:<addr-or-label>] [month:<YYYY-MM>]` — wallet defaults to the first `isMine` wallet; month defaults to the current UTC month.
- Every handler calls `deferReply()` first. Discord kills an interaction that is not acknowledged within 3 seconds, and a cold backfill query can exceed that.
- Errors reply ephemerally with `flags: MessageFlags.Ephemeral` (the `ephemeral: true` form is deprecated in discord.js v14).

- [x] **Step 1: Write the failing tests**

Create `apps/discord-bot/src/commands/commands.test.ts`. The fake interaction implements only the surface the handlers touch, so no Discord connection is involved:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { trackCommand } from './track';
import { untrackCommand } from './untrack';
import { pnlCommand } from './pnl';
import { EngineError } from '../engine/client';

function fakeInteraction(options: Record<string, string | boolean | null>) {
  const editReply = vi.fn();
  return {
    editReply,
    interaction: {
      options: {
        getSubcommand: () => 'wallet',
        getString: (name: string) => (options[name] as string) ?? null,
        getBoolean: (name: string) => (options[name] as boolean) ?? null,
      },
      deferReply: vi.fn(),
      editReply,
    } as any,
  };
}

describe('/track wallet', () => {
  it('tracks the address and confirms with the label', async () => {
    const engine = { trackWallet: vi.fn().mockResolvedValue({ id: 1, address: 'Addr1', label: 'Whale' }) } as any;
    const { interaction, editReply } = fakeInteraction({ address: 'Addr1', label: 'Whale', mine: false });

    await trackCommand.execute(interaction, { engine });

    expect(engine.trackWallet).toHaveBeenCalledWith('Addr1', 'Whale', false);
    expect(String(editReply.mock.calls[0][0].content ?? editReply.mock.calls[0][0])).toContain('Whale');
  });

  it('falls back to a shortened address when no label is given', async () => {
    // The engine answers 400 for a missing label, so the bot must supply one.
    const engine = { trackWallet: vi.fn().mockResolvedValue({ id: 1, address: 'A'.repeat(44), label: 'x' }) } as any;
    const { interaction } = fakeInteraction({ address: 'A'.repeat(44), label: null });

    await trackCommand.execute(interaction, { engine });

    const [, label] = engine.trackWallet.mock.calls[0];
    expect(label).toBeTruthy();
    expect(label.length).toBeLessThan(44);
  });

  it('reports an engine outage in plain language', async () => {
    const engine = { trackWallet: vi.fn().mockRejectedValue(new EngineError('engine unreachable', 0)) } as any;
    const { interaction, editReply } = fakeInteraction({ address: 'Addr1', label: 'Whale' });

    await trackCommand.execute(interaction, { engine });

    expect(JSON.stringify(editReply.mock.calls[0][0])).toContain('engine');
  });
});

describe('/untrack wallet', () => {
  it('resolves the address to an id before deleting', async () => {
    const engine = {
      listWallets: vi.fn().mockResolvedValue([{ id: 4, address: 'Addr1', label: 'Whale' }]),
      untrackWallet: vi.fn().mockResolvedValue(undefined),
    } as any;
    const { interaction } = fakeInteraction({ address: 'Addr1' });

    await untrackCommand.execute(interaction, { engine });

    expect(engine.untrackWallet).toHaveBeenCalledWith(4);
  });

  it('says so when the address is not tracked', async () => {
    const engine = { listWallets: vi.fn().mockResolvedValue([]), untrackWallet: vi.fn() } as any;
    const { interaction, editReply } = fakeInteraction({ address: 'Missing' });

    await untrackCommand.execute(interaction, { engine });

    expect(engine.untrackWallet).not.toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls[0][0])).toContain('not tracked');
  });
});

describe('/pnl', () => {
  it('defaults to the is-mine wallet and the current month', async () => {
    const engine = {
      listWallets: vi.fn().mockResolvedValue([
        { id: 1, address: 'Other', label: 'Whale', isMine: false },
        { id: 2, address: 'Mine', label: 'Me', isMine: true },
      ]),
      getPnl: vi.fn().mockResolvedValue([]),
    } as any;
    const { interaction, editReply } = fakeInteraction({ wallet: null, month: null });

    await pnlCommand.execute(interaction, { engine });

    expect(engine.getPnl).toHaveBeenCalledWith(2);
    const embed = editReply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.title).toContain(new Date().toISOString().slice(0, 7));
  });

  it('matches the wallet argument against label or address', async () => {
    const engine = {
      listWallets: vi.fn().mockResolvedValue([{ id: 9, address: 'Addr9', label: 'Whale', isMine: false }]),
      getPnl: vi.fn().mockResolvedValue([]),
    } as any;
    const { interaction } = fakeInteraction({ wallet: 'Whale', month: '2026-08' });

    await pnlCommand.execute(interaction, { engine });

    expect(engine.getPnl).toHaveBeenCalledWith(9);
  });

  it('rejects a malformed month instead of rendering a broken calendar', async () => {
    const engine = { listWallets: vi.fn().mockResolvedValue([]), getPnl: vi.fn() } as any;
    const { interaction, editReply } = fakeInteraction({ wallet: null, month: 'August' });

    await pnlCommand.execute(interaction, { engine });

    expect(engine.getPnl).not.toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls[0][0])).toContain('YYYY-MM');
  });

  it('explains when no wallet is tracked yet', async () => {
    const engine = { listWallets: vi.fn().mockResolvedValue([]), getPnl: vi.fn() } as any;
    const { interaction, editReply } = fakeInteraction({ wallet: null, month: null });

    await pnlCommand.execute(interaction, { engine });

    expect(JSON.stringify(editReply.mock.calls[0][0])).toContain('/track');
  });
});
```

- [x] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @cryptonix/discord-bot test -- commands`
Expected: FAIL — cannot find module `./track`

- [x] **Step 3: Create the shared command types**

Create `apps/discord-bot/src/commands/types.ts`:

```typescript
import type { ChatInputCommandInteraction } from 'discord.js';
import type { EngineClient } from '../engine/client.js';

export interface CommandDeps {
  engine: EngineClient;
}

export interface BotCommand {
  data: { name: string; toJSON(): unknown };
  execute(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void>;
}

/** Every command reports failure the same way: ephemeral, and never silent. */
export function describeError(err: unknown): string {
  const status = (err as { status?: number }).status;
  if (status === 0) return '⚠️ The engine is unreachable. Is it running?';
  if (status === 404) return '⚠️ The engine could not find that wallet.';
  return `⚠️ Engine error: ${(err as Error).message}`;
}

export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}
```

- [x] **Step 4: Implement `/track`**

Create `apps/discord-bot/src/commands/track.ts`:

```typescript
import { SlashCommandBuilder } from 'discord.js';
import { describeError, shortAddress, type BotCommand } from './types.js';

export const trackCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('track')
    .setDescription('Track a Solana wallet')
    .addSubcommand((sub) =>
      sub
        .setName('wallet')
        .setDescription('Track a Solana wallet address')
        .addStringOption((opt) => opt.setName('address').setDescription('Solana wallet address').setRequired(true))
        .addStringOption((opt) => opt.setName('label').setDescription('A name for this wallet'))
        .addBooleanOption((opt) => opt.setName('mine').setDescription('Is this your own wallet?'))
    ),

  async execute(interaction, { engine }) {
    // Registering a webhook and kicking off a backfill can outrun Discord's
    // 3-second interaction deadline, so acknowledge first.
    await interaction.deferReply();

    const address = interaction.options.getString('address', true);
    // The engine answers 400 when label is missing, so never send an empty one.
    const label = interaction.options.getString('label') ?? shortAddress(address);
    const isMine = interaction.options.getBoolean('mine') ?? false;

    try {
      const wallet = await engine.trackWallet(address, label, isMine);
      await interaction.editReply(
        `✅ Tracking **${wallet.label}** (\`${shortAddress(wallet.address)}\`). Historical backfill has started.`
      );
    } catch (err) {
      await interaction.editReply(describeError(err));
    }
  },
};
```

- [x] **Step 5: Implement `/untrack`**

Create `apps/discord-bot/src/commands/untrack.ts`:

```typescript
import { SlashCommandBuilder } from 'discord.js';
import { describeError, shortAddress, type BotCommand } from './types.js';

export const untrackCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('untrack')
    .setDescription('Stop tracking a wallet')
    .addSubcommand((sub) =>
      sub
        .setName('wallet')
        .setDescription('Stop tracking a Solana wallet address')
        .addStringOption((opt) => opt.setName('address').setDescription('Solana wallet address').setRequired(true))
    ),

  async execute(interaction, { engine }) {
    await interaction.deferReply();
    const address = interaction.options.getString('address', true);

    try {
      // The engine deletes by id; a human types an address. Resolve here.
      const wallets = await engine.listWallets();
      const wallet = wallets.find((w) => w.address === address);
      if (!wallet) {
        await interaction.editReply(`⚠️ \`${shortAddress(address)}\` is not tracked.`);
        return;
      }

      await engine.untrackWallet(wallet.id);
      await interaction.editReply(`🗑️ Stopped tracking **${wallet.label}** and released its Helius webhook.`);
    } catch (err) {
      await interaction.editReply(describeError(err));
    }
  },
};
```

- [x] **Step 6: Implement `/pnl`**

Create `apps/discord-bot/src/commands/pnl.ts`:

```typescript
import { SlashCommandBuilder } from 'discord.js';
import { buildPnlEmbed } from '../embeds/pnl.js';
import { describeError, type BotCommand } from './types.js';

const MONTH_PATTERN = /^\d{4}-\d{2}$/;

/** Current month in UTC, matching the UTC calendar maths in the heatmap. */
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export const pnlCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('pnl')
    .setDescription('Show realized PnL for a wallet')
    .addStringOption((opt) => opt.setName('wallet').setDescription('Wallet label or address'))
    .addStringOption((opt) => opt.setName('month').setDescription('Month as YYYY-MM')),

  async execute(interaction, { engine }) {
    await interaction.deferReply();

    const month = interaction.options.getString('month') ?? currentMonth();
    if (!MONTH_PATTERN.test(month)) {
      await interaction.editReply('⚠️ Month must look like `YYYY-MM`, for example `2026-08`.');
      return;
    }

    const walletQuery = interaction.options.getString('wallet');

    try {
      const wallets = await engine.listWallets();
      const wallet = walletQuery
        ? wallets.find((w) => w.label === walletQuery || w.address === walletQuery)
        : wallets.find((w) => w.isMine) ?? wallets[0];

      if (!wallet) {
        await interaction.editReply(
          walletQuery
            ? `⚠️ No tracked wallet matches \`${walletQuery}\`.`
            : '⚠️ No wallets are tracked yet. Add one with `/track wallet`.'
        );
        return;
      }

      const rows = await engine.getPnl(wallet.id);
      await interaction.editReply({ embeds: [buildPnlEmbed({ walletLabel: wallet.label, month, rows })] });
    } catch (err) {
      await interaction.editReply(describeError(err));
    }
  },
};
```

- [x] **Step 7: Implement the registry**

Create `apps/discord-bot/src/commands/registry.ts`. Guild-scoped registration is deliberate: guild commands appear immediately, while global ones can take up to an hour to propagate.

```typescript
import { REST, Routes } from 'discord.js';
import { trackCommand } from './track.js';
import { untrackCommand } from './untrack.js';
import { pnlCommand } from './pnl.js';
import type { BotCommand } from './types.js';

export const commands: BotCommand[] = [trackCommand, untrackCommand, pnlCommand];

export async function registerCommands(token: string, clientId: string, guildId: string): Promise<void> {
  const rest = new REST().setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commands.map((command) => command.data.toJSON()),
  });
}

// `pnpm --filter @cryptonix/discord-bot register-commands` runs this file directly.
if (process.argv[1]?.endsWith('registry.ts') || process.argv[1]?.endsWith('registry.js')) {
  const { env } = await import('../env.js');
  await registerCommands(env.discordToken, env.discordClientId, env.discordGuildId);
  console.log(`Registered ${commands.length} slash commands to guild ${env.discordGuildId}`);
}
```

- [x] **Step 8: Run and confirm it passes**

Run: `pnpm --filter @cryptonix/discord-bot test`
Expected: PASS — all bot tests, now 24

- [x] **Step 9: Commit**

```bash
git add apps/discord-bot/src/commands
git commit -m "discord-bot: add track, untrack and pnl slash commands"
```

---

### Task 11: `apps/discord-bot` — entrypoint and end-to-end verification

**Files:**
- Create: `apps/discord-bot/src/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–10.
- Produces: a runnable bot — `pnpm --filter @cryptonix/discord-bot dev`.

- [x] **Step 1: Write the entrypoint**

Create `apps/discord-bot/src/index.ts`:

```typescript
import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { env } from './env.js';
import { EngineClient } from './engine/client.js';
import { AlertStream } from './engine/alert-stream.js';
import { buildWalletTradeMessage, isWalletAlertPayload } from './embeds/wallet-buy.js';
import { commands } from './commands/registry.js';
import { describeError } from './commands/types.js';

const engine = new EngineClient(env.engineHttpUrl);
const commandsByName = new Map(commands.map((command) => [command.data.name, command]));

// Guilds is the only intent needed: slash commands and channel posting do not
// require any privileged intent, so the bot works without toggling anything
// extra in the Developer Portal.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = commandsByName.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, { engine });
  } catch (err) {
    // A handler that throws past its own catch must not take the process down.
    console.error(`command ${interaction.commandName} failed`, err);
    const message = describeError(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

const stream = new AlertStream({ url: env.engineWsUrl });

client.once(Events.ClientReady, async (ready) => {
  console.log(`discord bot ready as ${ready.user.tag}`);

  const channel = await client.channels.fetch(env.alertChannelId);
  if (!channel?.isTextBased() || !('send' in channel)) {
    throw new Error(`DISCORD_ALERT_CHANNEL_ID ${env.alertChannelId} is not a text channel the bot can post to`);
  }

  stream.onAlert(async (alert) => {
    // Phase 3 adds tweet and new-coin alerts to this same socket. Anything this
    // version does not understand is logged and skipped, never rendered.
    if (alert.type !== 'wallet_buy' && alert.type !== 'wallet_sell') return;
    if (!isWalletAlertPayload(alert.payload)) {
      console.error(`alert ${alert.refId} has an unexpected payload shape; skipping`);
      return;
    }

    try {
      await channel.send(buildWalletTradeMessage(alert.payload));
    } catch (err) {
      // A Discord outage or a revoked permission must not kill the process —
      // the engine keeps recording trades either way.
      console.error('failed to post alert to Discord', err);
    }
  });

  stream.start();
  console.log(`subscribed to engine alerts at ${env.engineWsUrl}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stream.stop();
    client.destroy();
    process.exit(0);
  });
}

client.login(env.discordToken).catch((err) => {
  console.error('discord login failed', err);
  process.exit(1);
});
```

- [x] **Step 2: Build everything**

Run: `pnpm build`
Expected: every package compiles, `@cryptonix/discord-bot` included

- [x] **Step 3: Run the full test suite**

Run: `pnpm test`
Expected: PASS — core, db, engine and discord-bot suites all green

- [ ] **Step 4: Register the slash commands**

Run: `pnpm --filter @cryptonix/discord-bot register-commands`
Expected: `Registered 3 slash commands to guild <your guild id>`

Guild commands appear immediately. If they do not show up in Discord, re-check that the bot was invited with the `applications.commands` scope.

- [ ] **Step 5: Start the stack**

Three terminals:

```bash
# 1 — Postgres (skip if the cryptonix-pg container is already running)
docker start cryptonix-pg

# 2 — engine
pnpm --filter @cryptonix/engine dev

# 3 — bot
pnpm --filter @cryptonix/discord-bot dev
```

Expected: the bot logs `discord bot ready as <name>#0000` and `subscribed to engine alerts at ws://localhost:8787/ws`.

- [ ] **Step 6: Exercise the commands in Discord**

In your server:

1. `/track wallet address:<a real Solana address> label:Whale mine:false`
   Expected: `✅ Tracking **Whale** … Historical backfill has started.`
2. `/pnl wallet:Whale`
   Expected: an embed titled `PnL — Whale — <current month>` with a heatmap grid. Straight after tracking, backfill may still be running, so an all-⬜ calendar and `—` win rate is the correct output, not a bug.
3. `/untrack wallet address:<the same address>`
   Expected: `🗑️ Stopped tracking **Whale** and released its Helius webhook.`

- [ ] **Step 7: Verify a live alert reaches Discord**

Rather than waiting for a real wallet to trade, replay a synthetic Helius delivery against the engine — the exact path a real webhook takes. Re-track a wallet first, then, with `WEBHOOK_SECRET` set to the value in your `.env`:

```bash
WALLET_ADDR="<the address you tracked>"
curl -X POST localhost:8787/webhooks/helius \
  -H 'Content-Type: application/json' \
  -H "Authorization: $WEBHOOK_SECRET" \
  -d "[{
    \"signature\": \"smoke-test-sig-1\",
    \"timestamp\": 1787000000,
    \"type\": \"SWAP\",
    \"tokenTransfers\": [{\"fromUserAccount\":\"Pool\",\"toUserAccount\":\"$WALLET_ADDR\",\"mint\":\"Mint1111111111111111111111111111111111111111\",\"tokenAmount\":1250000}],
    \"nativeTransfers\": [{\"fromUserAccount\":\"$WALLET_ADDR\",\"toUserAccount\":\"Pool\",\"amount\":2500000000}]
  }]"
```

Expected, within a second: a green **🟢 Buy — \<label\>** embed appears in your alerts channel, showing `2.5000 SOL`, `1,250,000` tokens, and an **Open on Axiom** button linking to `https://axiom.trade/t/Mint1111111111111111111111111111111111111111`.

If nothing appears, work down this list in order: the bot's log shows the WS subscribed; the engine's log shows the webhook accepted (a 401 means the `Authorization` header did not match `WEBHOOK_SECRET`); the bot has **Send Messages** and **Embed Links** in that channel.

- [ ] **Step 8: Verify reconnection**

Stop the engine (Ctrl-C in terminal 2), wait a few seconds, and start it again.

Expected: the bot logs socket errors while the engine is down but stays alive, then reconnects on its own. Replay the curl from Step 7 and confirm an embed still arrives.

- [x] **Step 9: Commit**

```bash
git add apps/discord-bot/src/index.ts
git commit -m "discord-bot: add entrypoint wiring alerts and commands"
```

---

## What you'll be able to see after this plan

- Wallet trades land in your Discord channel as colour-coded embeds within a second of Helius delivering them, each with a one-click **Open on Axiom** button.
- `/track wallet` and `/untrack wallet` manage tracked wallets from Discord, and untracking hands the Helius webhook back so the free-tier address cap does not leak.
- `/pnl` renders realized SOL, win rate, trading days, and best/worst day alongside a month calendar heatmap — no image pipeline, no native dependencies.
- The bot survives the engine restarting, and the engine is entirely unaffected by the bot dying.

## Next plan

Phase 3, **Signals** (spec §11.3): add the coin scanner and Twitter monitor to the engine, publishing `new_coin` and `tweet` alerts onto the same WebSocket this bot already consumes, plus their embeds and `/track twitter` commands. This plan's unknown-alert-type guard is what lets that ship without touching the wallet path. Note spec §12: the Twitter scraper provider is chosen at build time based on pricing and reliability then, not now.
