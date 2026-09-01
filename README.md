# Cryptonix

Solana wallet tracking. The engine watches wallets you follow, records their
swaps as they happen, computes realized PnL in SOL, and pushes an alert the
moment one of them trades. The Discord bot turns those alerts into embeds with
a one-click Axiom link, and answers `/pnl`.

No trades are ever placed. Cryptonix produces links, never orders.

## What is here

| Package | What it is |
|---|---|
| `apps/engine` | The service. Helius webhooks in, trades and PnL in Postgres, REST + WebSocket out. |
| `apps/discord-bot` | discord.js process. Alerts as embeds, plus `/setup`, `/track`, `/untrack`, `/pnl`. |
| `packages/core` | Pure domain logic: Axiom links, swap parsing, FIFO PnL, the heatmap. No I/O. |
| `packages/db` | Drizzle schema, migrations, and the Postgres client. |
| `tests/e2e` | A real engine on a real port against real Postgres, with the real bot pipeline wired to it. |

The design spec is `docs/superpowers/specs/2026-08-30-cryptonix-design.md`;
the implementation plans are alongside it in `docs/superpowers/plans/`.

## Prerequisites

- Node 20+ and pnpm
- Docker (for local Postgres)
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

Register the slash commands once (and again whenever they change):

```bash
pnpm --filter @cryptonix/discord-bot register-commands
```

Then, in any server the bot is in:

```
/setup                                  → alerts go to the channel you ran it in
/track wallet address:<solana address>  → follow a wallet, and backfill its history
/pnl                                    → realized SOL, win rate, best/worst day, month heatmap
/untrack wallet address:<address>       → stop following it, and release its Helius webhook
```

`/setup`, `/track` and `/untrack` require **Manage Server**. The wallet list is
shared by every server the bot is in, so untracking affects all of them.

## How it fits together

```
Helius ──webhook──▶ engine ──┬──▶ Postgres (trades, FIFO PnL)
                             │
                             └──▶ WebSocket ──▶ Discord bot ──▶ your channels
                                                     │
                     REST ◀───────────────────────────┘  (slash commands)
```

The bot owns no database. Every read and write goes through the engine, which
is the single writer — so a bot crash cannot corrupt state, and the Phase 4
desktop app will see exactly the same wallet list with no syncing code.

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
