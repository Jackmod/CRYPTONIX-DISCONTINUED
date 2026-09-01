# Cryptonix — Design Spec

Date: 2026-08-30
Status: Approved for planning

## 1. Overview

Cryptonix is a personal Solana trading command center. It watches wallets
and Twitter/X accounts, scans for promising new tokens, tracks realized
PnL (including the user's own wallet), and delivers everything through
two front ends: a 24/7 Discord bot and a local desktop "terminal" app.

Both front ends read from one shared always-on engine, so alerts and data
never drift out of sync between Discord and the desktop app.

## 2. Goals

- Track arbitrary Solana wallets; detect buys near-instantly and produce
  a ready-to-click Axiom copy-trade link.
- Track the user's own wallet(s): live SOL balance, trade history, PnL.
- Track Twitter/X handles (verified against the real account before
  tracking starts) and deliver new tweets as rich embeds, near-instantly.
- Continuously scan for new Solana tokens showing early momentum.
- Compute realized PnL (SOL-denominated, USD-converted) per wallet, with
  full historical backfill, rendered as a calendar heatmap.
- Deliver all of the above via a 24/7 Discord bot (rich embeds, not
  plain text) and a custom-designed desktop terminal app.
- Run on free-tier infrastructure only (Helius free tier, a cheap/free
  Twitter data source, free-tier Postgres and hosting).
- Each monitor is fault-isolated: one failing (e.g. the Twitter scraper)
  must not take down the others or the bot/API.

## 3. Non-goals

- No support for chains other than Solana.
- No automated trade execution — Cryptonix produces copy-trade links,
  it does not place trades itself.
- No multi-user/auth system — this is a single-operator personal tool.

## 4. Architecture

```
                         ┌─────────────────────────────┐
                         │   Cloud host (free tier)     │
                         │                              │
   Helius (webhooks/RPC) │  ┌────────────────────────┐  │
   ───────────────────► │  │        engine          │  │
                         │  │  wallet monitor         │  │
   Twitter scraper API   │  │  pnl tracker            │  │
   ───────────────────► │  │  coin scanner           │  │
                         │  │  twitter monitor         │  │
                         │  │  REST + WebSocket API    │  │
                         │  └───────────┬─────────────┘  │
                         │              │ alerts/queries  │
                         │  ┌───────────▼─────────────┐  │
                         │  │     discord-bot          │  │
                         │  └──────────────────────────┘  │
                         │              │                  │
                         │        ┌─────▼─────┐            │
                         │        │  Postgres  │            │
                         │        └────────────┘            │
                         └───────────────┬──────────────────┘
                                         │ WebSocket/REST
                                ┌────────▼─────────┐
                                │  desktop (Tauri)   │
                                │  terminal UI, local │
                                └────────────────────┘
```

`engine` and `discord-bot` deploy together to a free-tier host (Fly.io).
`desktop` runs locally on the user's PC and talks to the deployed engine
remotely, so it works identically whether or not the local PC is the
one running the bot.

## 5. Components

### 5.1 engine (`apps/engine`)

Always-on Node/TypeScript service. Internally organized as independent
modules, each with its own error boundary and auto-restart supervisor —
a crash in one monitor does not affect the others or the API server.

- **wallet monitor** — registers/unregisters Helius webhooks per tracked
  wallet address. On an incoming swap transaction: parses token bought,
  amount, and price; builds the Axiom link (`axiom.trade/t/<mint>`);
  writes an alert row. Also exposes live SOL balance (via RPC) and a
  parsed trade-history feed per wallet. Tracks a "watching N / free-tier
  limit" gauge so webhook capacity issues are visible, not silent.
- **pnl tracker** — triggered whenever a wallet (tracked or `is_mine`)
  is added. Backfills full transaction history via Helius, filters to
  DEX swaps (Jupiter/Raydium/pump.fun), and FIFO-matches buy lots
  against sells per token to compute realized PnL natively in SOL.
  Converts to USD using a cached historical SOL/USD price (free source,
  e.g. CoinGecko), so no per-token historical USD feed is needed.
  Rolls trades up into daily aggregates for the calendar view. Live
  trades from the wallet monitor extend the running total without
  re-backfilling.
- **coin scanner** — subscribes to pump.fun/Raydium mint activity via
  Helius. Tracks each new token's first minutes: volume, unique buyers,
  buy/sell ratio, liquidity added. Resolves each token's real image and
  name from its on-chain metadata (Metaplex URI, via Helius's DAS
  `getAsset`) at discovery time, so alerts carry the actual coin art, not
  a placeholder. Scores momentum on a rolling window and emits an alert
  once a token crosses threshold. No per-token setup required.
- **twitter monitor** — on registration, resolves the handle through the
  scraper API and returns the real account (name, avatar, follower
  count, verified badge) for confirmation before tracking starts. Then
  polls/streams for new tweets and emits an alert with full tweet
  content + media references for embed rendering.
- **API** — REST for CRUD (add/remove tracked wallets & handles, query
  history/PnL) and WebSocket for the live alert stream, consumed by both
  `discord-bot` and `desktop`.

### 5.2 discord-bot (`apps/discord-bot`)

discord.js process, deployed alongside `engine`. Subscribes to the
engine's alert WebSocket and posts rich embeds:

- Wallet-buy alert: embed with token, amount, wallet label, Axiom link
  button.
- Tweet alert: embed styled like a tweet card — author name/handle/
  avatar, tweet text, media thumbnail if present, timestamp, "View on
  X" link.
- New-coin alert: embed with momentum stats + Axiom link button.
- `/pnl [wallet] [month]` slash command: embed with total realized PnL,
  win rate, best/worst day, plus a server-rendered calendar heatmap
  image attached.
- `/track wallet <address> [label]`, `/track twitter <handle>`,
  `/untrack ...`: management commands, mirrored in the desktop app.

### 5.3 desktop (`apps/desktop`)

Tauri (Rust shell + React UI), local app, terminal-style dark dense
layout — custom-designed, not a generic dashboard template:

- **Left nav:** Wallets, Coins, Calls, PnL, Settings.
- **Wallets (default/hero view):** table of tracked wallets + the user's
  own (`is_mine`, pinned first, shows live SOL balance). Row click
  drills into trade history + PnL for that wallet.
- **Right rail (persistent across tabs):** combined live feed —
  new-coin and tweet alerts interleaved by time, terminal-ticker style.
- **Coins tab:** ranked momentum list from the scanner, Axiom button
  per row.
- **Calls tab:** tracked handles, streaming tweet embeds.
- **PnL tab:** calendar heatmap (green/red by day), wallet switcher
  (Me / any tracked wallet), click-through to that day's trades.
- **Settings:** manage tracked wallets/handles, connection/host config.

Connects to the deployed `engine` over WebSocket (live) + REST
(queries), same data contract the Discord bot uses.

**Real imagery, not placeholders:** every surface renders the actual
image for what it's showing — the coin's real on-chain logo, the X
account's real avatar, and real tweet media when a tracked tweet has
an image attached. Wallets are the one exception: a raw Solana address
has no inherent picture, so wallet rows use a deterministically
generated identicon (address → pattern, same approach Phantom/MetaMask
use), not a photo.

## 6. Data model (Postgres, via Drizzle ORM)

Core tables (exact columns refined during implementation):

- `wallets` (address, label, is_mine, added_at, watching status)
- `wallet_trades` (wallet_id, signature, mint, side, sol_amount,
  token_amount, price_sol, ts)
- `pnl_daily` (wallet_id, date, realized_pnl_sol, realized_pnl_usd,
  trade_count)
- `twitter_accounts` (handle, resolved_user_id, display_name, avatar_url,
  added_at)
- `tweets_seen` (account_id, tweet_id, text, media, ts)
- `coin_alerts` (mint, image_uri, momentum_score, stats_json, ts)
- `alerts` (unified feed: type, ref_id, payload_json, ts) — the single
  stream both front ends subscribe to.

## 7. Third-party services & constraints

- **Helius (free tier)** — wallet webhooks, RPC, transaction parsing.
  Free tier caps concurrent webhook addresses and request rate; the
  engine surfaces capacity/limit state rather than failing silently.
- **Twitter data** — cheap unofficial scraper API (e.g. TwitterAPI.io
  class of service), not the official X API. Accepted tradeoff: small
  risk of breakage if the provider is blocked/changes; kept isolated in
  its own module so a break doesn't affect other monitors.
- **SOL/USD price** — free historical price source (e.g. CoinGecko),
  cached to avoid rate limits.
- **Postgres** — free tier (Neon or Supabase).
- **Hosting** — free tier (Fly.io) for `engine` + `discord-bot`.

## 8. Codebase structure

```
cryptonix/
  apps/
    desktop/        # Tauri + React terminal UI
    engine/         # monitors + REST/WS API
    discord-bot/     # discord.js bot
  packages/
    core/            # domain logic, split by concern:
      pnl/            #   FIFO cost-basis + PnL calc
      axiom-links/     #   link builder
      wallet-parsing/  #   swap tx parsing
    db/              # Drizzle schema + client
    config/          # shared eslint/tsconfig/prettier
  .github/workflows/ # CI: lint, typecheck, build
  pnpm-workspace.yaml
  turbo.json
```

pnpm workspaces + Turborepo for task orchestration/caching. No
god-files: each monitor, and each domain concern in `core`, lives in
its own module and is independently testable.

## 9. Resilience & fault isolation

Each monitor runs under its own supervised loop with error boundaries
and auto-restart with backoff. A crash or upstream failure in one
monitor (e.g. Twitter scraper API down) logs, retries, and continues
without affecting wallet tracking, PnL, coin scanning, the API, or the
Discord bot.

## 10. Testing

- `packages/core` (PnL/FIFO math, Axiom link building, swap parsing):
  unit tests — these are pure functions and the highest-value place for
  correctness (money math must be right).
- `engine` monitors: tested against recorded/fixture webhook payloads
  and API responses, not live network calls.
- `discord-bot` and `desktop`: manual verification against a running
  engine (dev environment) — no meaningful UI/bot test automation for a
  v1 personal tool.

## 11. Build order (phased; detailed steps go in the implementation plan)

1. **Foundation** — monorepo scaffold, DB schema, `packages/core`
   basics, `engine` with wallet monitor (balance, live buy detection,
   trade history) + PnL tracker (backfill + FIFO calc) + REST/WS API.
   This is the dependency root for everything else.
2. **Discord bot v1** — wired to `engine`, wallet-buy alerts, `/pnl`
   command, `/track`/`/untrack` wallet commands.
3. **Signals** — coin scanner + twitter monitor added to `engine`, their
   Discord embed alerts and track/untrack commands.
4. **Desktop terminal app** — full custom UI (all tabs) against the by
   now feature-complete `engine` API.

## 12. Open risks / assumptions

- Twitter scraper API choice not yet finalized — pick during Phase 3
  based on current pricing/reliability at build time.
- ~~Helius free-tier webhook address cap is not exactly known ahead of
  build~~ — **resolved 2026-09-01.** Helius documents 5 webhooks on the
  free tier (50 on paid) and 100,000 addresses per webhook. The engine
  originally created one webhook per wallet, which capped the whole
  product at five tracked wallets while using a twenty-thousandth of what
  a single webhook holds. It now keeps ONE shared webhook and edits its
  address list, so the ceiling is 100,000 wallets. Management calls cost
  100 credits each, so adding a wallet is one edit rather than one create.
- Momentum-scoring thresholds for the coin scanner will need real-world
  tuning after launch — v1 ships with a reasonable starting formula, not
  a promise of optimality. Measured against live DexScreener on
  2026-09-01: the shipped defaults passed 0 of 18 sampled coins, with
  `minVolume5m` and `minBuyRatio` the binding gates. See the Phase 3
  spike for the numbers; every threshold is overridable from `.env`.
- Token-to-token swaps are recorded with a zero SOL cost basis, so
  selling such a position later overstates realized PnL. The side is
  decided by the token direction and the amount by the native SOL moving
  with it, and a token→token swap moves no lamports. Refusing to record a
  zero-SOL buy is not a safe fix blind: a real SOL purchase routed through
  wrapped SOL can look the same, and dropping those would silently lose
  genuine trades. Needs live Helius delivery data to separate the two.
  Nearly every memecoin swap is SOL-paired, so the exposure is small.
