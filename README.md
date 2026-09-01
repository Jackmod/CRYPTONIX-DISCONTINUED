# Cryptonix

Solana wallet tracking. The engine watches wallets you follow, records their
swaps as they happen, computes realized PnL in SOL, and pushes an alert the
moment one of them trades. The Discord bot turns those alerts into embeds with
a one-click Axiom link, and answers `/pnl`. The desktop app shows the same
data on a live terminal-style dashboard.

No trades are ever placed. Cryptonix produces links, never orders.

## What is here

| Package | What it is |
|---|---|
| `apps/engine` | The service. Helius webhooks in, trades and PnL in Postgres, REST + WebSocket out. Optional new-coin scanner. |
| `apps/discord-bot` | discord.js process. Alerts as embeds, plus `/setup`, `/track`, `/untrack`, `/wallets`, `/following`, `/pnl`, `/status`. |
| `apps/desktop` | Tauri + React desktop app. Wallets, coins, tweet cards, PnL calendar, and a live feed. |
| `packages/core` | Pure domain logic: Axiom links, swap parsing, FIFO PnL, the heatmap, coin momentum. No I/O. |
| `packages/db` | Drizzle schema, migrations, and the Postgres client. |
| `tests/e2e` | A real engine on a real port against real Postgres, with the real bot pipeline wired to it. |

The design spec is `docs/superpowers/specs/2026-08-30-cryptonix-design.md`;
the implementation plans are alongside it in `docs/superpowers/plans/`.

## Prerequisites

- Node 20+ and pnpm
- Docker (for local Postgres)
- **Rust** (only to build the desktop app) — https://rustup.rs
- A free **Helius** API key — https://www.helius.dev
- A **Discord application** — https://discord.com/developers/applications
- **ngrok** or equivalent, so Helius can reach your machine

## Setup

```bash
pnpm install
docker run -d --name cryptonix-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
cp .env.example .env          # then fill it in, see below
pnpm --filter @cryptonix/db db:push
```

### Filling in `.env`

`.env` is gitignored and must stay that way — it holds three secrets.

| Variable | Where it comes from |
|---|---|
| `DATABASE_URL` | The Postgres above; the default works as-is |
| `HELIUS_API_KEY` | Helius dashboard, after signing up |
| `WEBHOOK_BASE_URL` | **Must be publicly reachable.** Run `ngrok http 8787` and use the https URL |
| `WEBHOOK_SECRET` | Any random string. Helius echoes it back so forged deliveries can be rejected |
| `ENGINE_API_KEY` | Any random string: `openssl rand -hex 32`. Guards every engine route |
| `DISCORD_TOKEN` | Developer portal → Bot → Reset Token |
| `DISCORD_CLIENT_ID` | Developer portal → General Information → Application ID |
| `DISCORD_GUILD_ID` | Optional. A dev server id, so commands appear instantly instead of after global propagation |
| `ENGINE_HTTP_URL` / `ENGINE_WS_URL` | Where the bot finds the engine; the defaults work locally |

`WEBHOOK_BASE_URL` pointing at localhost is the single most common problem:
Helius cannot reach it, so every `/track` fails. The engine warns about this at
startup.

### Inviting the bot

In the developer portal, under **Installation** (or OAuth2 → URL Generator),
select scopes `bot` and `applications.commands`, and permissions **Send
Messages** and **Embed Links**. Open the generated URL and pick your server.

## Running it

Three terminals:

```bash
docker start cryptonix-pg
pnpm --filter @cryptonix/engine dev
pnpm --filter @cryptonix/discord-bot dev
```

The desktop app is a fourth, and optional — the bot does not need it:

```bash
pnpm --filter @cryptonix/desktop tauri dev     # native window
pnpm --filter @cryptonix/desktop dev           # or just in a browser, on :5173
```

On first run, open **Settings** and paste the same `ENGINE_API_KEY` the engine
uses. The engine sends permissive CORS headers so the webview can reach it —
its origin is never the engine's — which is safe because this API carries no
cookies: a request from anywhere without the key is refused. The URLs default to `http://localhost:8787` and `ws://localhost:8787/ws`.
Settings are stored on that machine only, never in the repo.

To produce installers (`.msi` and `.exe` on Windows, `.dmg` on macOS,
`.deb`/`.AppImage` on Linux):

```bash
pnpm --filter @cryptonix/desktop tauri build
```

Register the slash commands once (and again whenever they change):

```bash
pnpm --filter @cryptonix/discord-bot register-commands
```

Then, in any server the bot is in:

```
/setup                                  → alerts go to the channel you ran it in
/track wallet address:<solana address>  → follow a wallet, and backfill its history
/track twitter handle:@someone          → follow an X account, and post its tweets here
/wallets                                → list the wallets being tracked
/following                              → list the X accounts being followed
/pnl                                    → realized SOL, win rate, best/worst day, month heatmap
/untrack wallet address:<address>       → stop following it, and release its Helius webhook
/untrack twitter handle:@someone        → stop following an account
/status                                 → is it set up, can it post, is the engine up
```

Renaming a wallet, or marking one as yours after the fact, is done in the
desktop app's **Settings** — untracking would delete its trades and PnL and
cost a fresh Helius backfill to get back.

Following an X account is deliberately quiet: the first poll records that
account's recent tweets so the Calls tab has something to show, but posts none
of them. Only what it writes afterwards reaches your channels.

`/pnl` and `/untrack` autocomplete the wallet, so nobody has to retype a
44-character address. `/pnl` attaches a rendered calendar heatmap; the Unicode
version stays in the embed as the fallback that copies as text and reads aloud.
The image is drawn by a small PNG encoder in the bot — no native image library
to install or break on a Node upgrade.

`/setup`, `/track` and `/untrack` require **Manage Server**; `/status` does
not, because anyone wondering why a channel is quiet should be able to ask. The wallet list is
shared by every server the bot is in, so untracking affects all of them.

## How it fits together

```
                             ┌──▶ Postgres (trades, FIFO PnL)
                             │
Helius ──webhook──▶ engine ──┼──▶ WebSocket ──┬──▶ Discord bot ──▶ your channels
                             │                └──▶ desktop app ──▶ live feed
                             │
                             └──▶ REST ───────┬──▶ Discord bot  (slash commands)
                                              └──▶ desktop app  (tables, PnL)
```

The bot and the app own no database. Every read and write goes through the
engine, which is the single writer — so a crash on either side cannot corrupt
state, and both see exactly the same wallet list with no syncing code. A wallet
added in the app's **Settings** is the row `/track wallet` creates in Discord,
and the reverse; the app re-reads the list every 20 seconds, because tracking
publishes no alert for the socket to carry.

Alerts the bot misses while it is disconnected are not lost: the engine records
every alert, and the bot replays anything published since its stored cursor
whenever it reconnects.

## Tests

```bash
pnpm test          # everything: unit, integration, e2e
pnpm build         # typecheck and compile all packages
```

The e2e suite needs Postgres running. Each package uses its own test database,
because they run in parallel and truncate the same tables:

```bash
for db in cryptonix_test cryptonix_test_db cryptonix_test_e2e; do
  docker exec cryptonix-pg psql -U postgres -c "CREATE DATABASE $db;"
  DATABASE_URL="postgres://postgres:postgres@localhost:5432/$db" \
    pnpm --filter @cryptonix/db db:push
done
```

## New-coin scanner

Off by default. Set `COIN_SCANNER_ENABLED=true` and the engine polls
DexScreener once a minute for newly launched Solana coins, scores their
short-term momentum, and publishes a `new_coin` alert for any that clear every
gate. It needs no account and no key.

A coin is alerted at most once, ever — the `scanned_coins` table remembers
what has been considered, so a restart does not re-alert everything. Coins
that were rejected are recorded too, and stay eligible: plenty launch quiet
and move minutes later.

### Tuning the thresholds

The defaults are deliberately conservative — a scanner that cries wolf is
worse than one that stays quiet. Every gate is an environment variable
(`COIN_MIN_VOLUME_5M` and friends, listed in `.env.example`), so tuning never
needs a code change.

To pick values from evidence rather than taste:

```bash
pnpm --filter @cryptonix/engine exec tsx scripts/threshold-sweep.ts
```

That samples the coins listed right now, prints their momentum side by side,
and reports how many would pass each gate set. Memecoin launches are bursty,
so run it across a few different hours before moving anything. If nothing
passes, look at the distribution to see which gate is binding — often the
market is simply quiet.

## Checking the engine without Discord

`scripts/smoke-test.ts` drives a running engine over HTTP and WebSocket the way
a real client would — register a wallet, replay a synthetic Helius delivery,
confirm the alert arrives with the right Axiom link, read the trade back, then
untrack.

```bash
pnpm --filter @cryptonix/engine exec tsx scripts/smoke-test.ts --skip-helius
```

`--skip-helius` inserts the wallet row directly, so the whole alert pipeline is
exercised without a public `WEBHOOK_BASE_URL`. Drop the flag to test real
webhook registration too.

## Security notes

`WEBHOOK_BASE_URL` has to be publicly reachable for Helius to deliver, which
puts the engine on the internet. Accordingly:

- Every route except `/webhooks/helius` requires `Authorization: Bearer
  $ENGINE_API_KEY`, checked in constant time, before the request body is parsed.
- `/webhooks/helius` authenticates with `WEBHOOK_SECRET`, which Helius echoes
  back on every delivery. Without it, anyone could forge a trade and corrupt
  realized PnL.
- The alert WebSocket requires the same API key. It carries every tracked
  wallet's trades in real time.
- Errors answer JSON and never expose internals.

Keep the engine behind ngrok rather than a permanently open port, and treat
`ENGINE_API_KEY`, `WEBHOOK_SECRET` and `DISCORD_TOKEN` as passwords.

## Free-tier limits

Cryptonix is built to run on free tiers (spec §7). Helius allows 10 requests a
second and caps how many addresses may hold a webhook, so:

- Outbound Helius calls are rate limited to 8/s and retry on 429.
- Untracking always releases the wallet's webhook, and a failed release leaves
  the wallet retryable rather than leaking a slot.
- Backfill is capped at 20 pages per wallet.

## Twitter, and the one thing that costs money

Everything in Cryptonix is free to run except **finding out that a tracked X
account has posted**. Checked on 2026-09-01:

- X's own free API tier is write-only — it cannot read tweets at all.
- Nitter was served cease-and-desist letters on 2026-08-24 and its repository
  archived. `xcancel.com`, `rsshub.app` and the other surviving bridges
  answered 302 or 404 when tried directly.
- Self-hosting a bridge now requires supplying your own X session tokens,
  which is how the account gets suspended.

**Rendering a tweet is free and always will be.** X's own embed CDN — the
endpoint behind every embedded tweet on the web — needs no key and returns the
author's name, handle, real avatar, text, media and timestamp. That is
`apps/engine/src/twitter/syndication.ts`, and it is why the Calls tab, the
Discord tweet card and the alert pipeline all work with no credentials.

Discovery sits alone behind a `TweetSource` interface
(`apps/engine/src/twitter/source.ts`). The shipped implementation is
TwitterAPI.io; pointing it at Telegram or Bluesky, both genuinely free, is one
file and touches nothing else.

Set `TWITTER_API_KEY` to turn discovery on. Without it the engine says so at
startup and simply never finds new tweets.

**Cost is about polling, not tweets.** The provider charges per tweet returned
*and* a floor fee per call, so an empty poll still costs. Twenty handles polled
every minute is roughly $130/month; the tweets themselves are under a dollar.
`TWEET_POLL_INTERVAL_MS` defaults to two minutes for that reason, and for more
than a handful of handles their webhook filter rules (`from:a OR from:b`) push
instead of polling and bill nothing for silence.
