# Cryptonix Multi-Server Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Discord bot usable in any server. Each server runs `/setup` to choose its own alert channel; alerts fan out to every configured server. The wallet list stays shared, so anything added from Discord, `curl`, or the Phase 4 desktop app is visible everywhere with no sync code.

**Architecture:** One new table, `discord_guilds`, holding guild → channel routing. The engine remains the only database writer and exposes REST CRUD for that config; the bot reads and writes it through the same `EngineClient` it already uses. Slash commands move from guild-scoped to global registration so the bot works in servers it has never seen. The alert path changes from "post to one env-configured channel" to "post once per configured guild, each send isolated".

**Tech Stack:** Unchanged — TypeScript, discord.js v14, Drizzle, Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-30-cryptonix-design.md`
**Builds on:** `docs/superpowers/plans/2026-08-31-cryptonix-discord-bot-v1.md` (branch `discord-bot-v1`, unmerged)

## Global Constraints

- Solana only; free-tier infrastructure only; no automated trade execution (spec §2, §3, §7).
- One clear responsibility per file; no god-files (spec §8, §9).
- The engine stays the single database writer. The bot never opens a database connection (spec §4).
- The bot must never take the engine down, and must survive the engine being down (spec §9).
- **Import convention:** relative imports in source files carry `.js`; test files omit it.
- Tests never make live Discord or live Helius calls.
- **No wallet-table changes.** `wallets`, `wallet_trades` and `pnl_daily` are untouched, so the existing dev data (5 wallets, 5 trades, 2 PnL rows) needs no migration.

## Design decisions settled before this plan

- **Shared wallet list, per-server routing.** Every configured server receives every alert, each in its own channel. Wallets are not owned by a guild. This is what makes app ↔ bot sync automatic rather than a feature: `/track` in Discord and the desktop app's "add wallet" are the same `POST /wallets` against the same database.
- **One channel per server**, not one per signal type. Phase 3's tweet and new-coin alerts will land in the same channel; splitting later is additive.
- **`/setup` requires Manage Server.** Without it, any member could redirect a server's alert feed.
- **Global command registration.** `DISCORD_GUILD_ID` becomes optional: when set, commands also register to that one guild, which appears instantly instead of waiting for global propagation. This is a development convenience, not a requirement.

---

## File Structure

**Modified — db:**

| File | Change |
|---|---|
| `packages/db/src/schema.ts` | + `discordGuilds` table |
| `packages/db/drizzle/` | + generated migration |
| `packages/db/src/schema.test.ts` | + round-trip test |

**Modified — engine:**

| File | Change |
|---|---|
| `apps/engine/src/api/server.ts` | + three `/discord/guilds` routes |
| `apps/engine/src/api/server.test.ts` | + route tests |

**Modified — bot:**

| File | Change |
|---|---|
| `src/env.ts` | `DISCORD_ALERT_CHANNEL_ID` removed; `DISCORD_GUILD_ID` optional |
| `src/engine/client.ts` | + `listGuildConfigs`, `setGuildConfig` |
| `src/commands/registry.ts` | global registration; + `setupCommand` |
| `src/index.ts` | fan-out, guild cache, join prompt |

**Created — bot:**

| File | Responsibility |
|---|---|
| `src/commands/setup.ts` | `/setup` definition + handler |
| `src/guilds/config-cache.ts` | In-memory guild → channel map, refreshed from the engine |

---

### Task 1: db — `discord_guilds` table

**Files:**
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/schema.test.ts`
- Create: `packages/db/drizzle/` migration (generated, do not hand-write)

**Interfaces:**
- Produces: `discordGuilds` table export — `{ guildId: string (PK), alertChannelId: string, setupBy: string | null, setupAt: Date }`. Tasks 2–7 consume it.

**Why `guildId` is the primary key and not a serial:** a Discord snowflake is already a unique, stable identifier, and every lookup is "what channel does this guild use?". A surrogate key would add a second unique index for nothing.

- [x] **Step 1: Add the table to the schema**

Append to `packages/db/src/schema.ts`:

```typescript
export const discordGuilds = pgTable('discord_guilds', {
  guildId: text('guild_id').primaryKey(),
  alertChannelId: text('alert_channel_id').notNull(),
  setupBy: text('setup_by'),
  setupAt: timestamp('setup_at').notNull().defaultNow(),
});
```

- [x] **Step 2: Write the failing test**

Append to `packages/db/src/schema.test.ts`, and extend the import on line 2 to `import { createDb, wallets, discordGuilds } from './index';`:

```typescript
describe('discord_guilds table', () => {
  beforeEach(async () => {
    await db.execute('TRUNCATE discord_guilds CASCADE');
  });

  it('inserts and reads back a guild config', async () => {
    const [inserted] = await db
      .insert(discordGuilds)
      .values({ guildId: 'guild1', alertChannelId: 'channel1', setupBy: 'user1' })
      .returning();

    expect(inserted.guildId).toBe('guild1');
    expect(inserted.setupAt).toBeInstanceOf(Date);
  });

  it('upserts on conflict so re-running /setup moves the channel', async () => {
    // /setup is expected to be run more than once — a server changing its mind
    // about which channel gets alerts must not hit a primary key violation.
    await db.insert(discordGuilds).values({ guildId: 'guild1', alertChannelId: 'channel1' });
    await db
      .insert(discordGuilds)
      .values({ guildId: 'guild1', alertChannelId: 'channel2' })
      .onConflictDoUpdate({ target: discordGuilds.guildId, set: { alertChannelId: 'channel2' } });

    const rows = await db.select().from(discordGuilds);
    expect(rows).toHaveLength(1);
    expect(rows[0].alertChannelId).toBe('channel2');
  });
});
```

- [x] **Step 3: Run and confirm it fails**

Run: `pnpm --filter @cryptonix/db test`
Expected: FAIL — relation "discord_guilds" does not exist

- [x] **Step 4: Generate and apply the migration**

```bash
pnpm --filter @cryptonix/db db:generate
pnpm --filter @cryptonix/db db:push
```

Then apply the same schema to the test database, which `db:push` does not touch:

```bash
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @cryptonix/db db:push
```

Expected: a new file under `packages/db/drizzle/` creating `discord_guilds`, and both databases updated.

- [x] **Step 5: Run and confirm it passes**

Run: `pnpm --filter @cryptonix/db test`
Expected: PASS — 4 tests

- [x] **Step 6: Commit**

```bash
git add packages/db
git commit -m "db: add discord_guilds table for per-server alert routing"
```

---

### Task 2: engine — guild config routes

**Files:**
- Modify: `apps/engine/src/api/server.ts`
- Modify: `apps/engine/src/api/server.test.ts`

**Interfaces:**
- Consumes: `discordGuilds` from Task 1.
- Produces:
  - `GET /discord/guilds` → `[{ guildId, alertChannelId, setupBy, setupAt }]`
  - `PUT /discord/guilds/:guildId` body `{ alertChannelId, setupBy? }` → `200` with the stored row; upserts.
  - `DELETE /discord/guilds/:guildId` → `204` always (idempotent).

  Task 3's client methods consume these.

**Why PUT upserts rather than POST-then-PATCH:** `/setup` is idempotent from the user's point of view — running it again just moves the channel. One route that always converges on the requested state is simpler than making the bot decide whether a config already exists.

- [x] **Step 1: Write the failing tests**

Add to the `describe('engine API', ...)` block in `apps/engine/src/api/server.test.ts`. Extend the `beforeEach` TRUNCATE on line 15 to include the new table:

```typescript
    await db.execute('TRUNCATE alerts, pnl_daily, wallet_trades, wallets, discord_guilds RESTART IDENTITY CASCADE');
```

Then the tests:

```typescript
  it('PUT /discord/guilds/:id stores a guild config and GET lists it', async () => {
    const app = buildApp();

    const putRes = await request(app)
      .put('/discord/guilds/guild1')
      .send({ alertChannelId: 'channel1', setupBy: 'user1' });
    expect(putRes.status).toBe(200);
    expect(putRes.body.alertChannelId).toBe('channel1');

    const listRes = await request(app).get('/discord/guilds');
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].guildId).toBe('guild1');
  });

  it('PUT /discord/guilds/:id twice moves the channel instead of erroring', async () => {
    // Re-running /setup is normal, not an error case.
    const app = buildApp();

    await request(app).put('/discord/guilds/guild1').send({ alertChannelId: 'channel1' });
    const second = await request(app).put('/discord/guilds/guild1').send({ alertChannelId: 'channel2' });

    expect(second.status).toBe(200);
    const listRes = await request(app).get('/discord/guilds');
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].alertChannelId).toBe('channel2');
  });

  it('PUT /discord/guilds/:id without a channel returns 400', async () => {
    const app = buildApp();
    const res = await request(app).put('/discord/guilds/guild1').send({});
    expect(res.status).toBe(400);
  });

  it('DELETE /discord/guilds/:id removes the config and is idempotent', async () => {
    const app = buildApp();
    await request(app).put('/discord/guilds/guild1').send({ alertChannelId: 'channel1' });

    expect((await request(app).delete('/discord/guilds/guild1')).status).toBe(204);
    // Deleting again must still succeed: the bot calls this when it is removed
    // from a server, and Discord can deliver that event more than once.
    expect((await request(app).delete('/discord/guilds/guild1')).status).toBe(204);

    const listRes = await request(app).get('/discord/guilds');
    expect(listRes.body).toHaveLength(0);
  });
```

- [x] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @cryptonix/engine test -- server`
Expected: FAIL — 404 from Express for the unregistered routes

- [x] **Step 3: Implement the routes**

Add to `apps/engine/src/api/server.ts` after the `DELETE /wallets/:id` route. Extend the `@cryptonix/db` import at the top of the file to include `discordGuilds`:

```typescript
  app.get(
    '/discord/guilds',
    asyncRoute(async (_req, res) => {
      res.json(await db.select().from(discordGuilds));
    })
  );

  app.put(
    '/discord/guilds/:guildId',
    asyncRoute(async (req, res) => {
      const { alertChannelId, setupBy } = (req.body ?? {}) as { alertChannelId?: string; setupBy?: string };
      if (!alertChannelId) {
        res.status(400).json({ error: 'alertChannelId is required' });
        return;
      }

      // Upsert: /setup is idempotent, and re-running it to move channels is
      // expected use, not a conflict.
      const [row] = await db
        .insert(discordGuilds)
        .values({ guildId: req.params.guildId, alertChannelId, setupBy })
        .onConflictDoUpdate({
          target: discordGuilds.guildId,
          set: { alertChannelId, setupBy, setupAt: new Date() },
        })
        .returning();
      res.json(row);
    })
  );

  app.delete(
    '/discord/guilds/:guildId',
    asyncRoute(async (req, res) => {
      // Idempotent on purpose: the bot calls this when kicked from a server,
      // and Discord may deliver that event more than once.
      await db.delete(discordGuilds).where(eq(discordGuilds.guildId, req.params.guildId));
      res.status(204).end();
    })
  );
```

- [x] **Step 4: Run and confirm it passes**

Run: `pnpm --filter @cryptonix/engine test`
Expected: PASS — 37 tests

- [x] **Step 5: Commit**

```bash
git add apps/engine/src/api
git commit -m "engine: add Discord guild config routes"
```

---

### Task 3: bot — guild config client and env changes

**Files:**
- Modify: `apps/discord-bot/src/engine/client.ts`
- Modify: `apps/discord-bot/src/engine/client.test.ts`
- Modify: `apps/discord-bot/src/env.ts`
- Modify: `apps/discord-bot/src/env.test.ts`

**Interfaces:**
- Consumes: the routes from Task 2.
- Produces:
  ```typescript
  export interface GuildConfig {
    guildId: string; alertChannelId: string; setupBy: string | null; setupAt: string;
  }
  // on EngineClient:
  listGuildConfigs(): Promise<GuildConfig[]>
  setGuildConfig(guildId: string, alertChannelId: string, setupBy?: string): Promise<GuildConfig>
  ```
  And an `env` without `alertChannelId`, with `devGuildId: string | undefined`.

- [x] **Step 1: Write the failing client tests**

Add to `describe('EngineClient', ...)` in `apps/discord-bot/src/engine/client.test.ts`:

```typescript
  it('lists guild configs', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ guildId: 'g1', alertChannelId: 'c1' }],
    });

    const configs = await new EngineClient('http://engine:8787').listGuildConfigs();

    expect(configs[0].guildId).toBe('g1');
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('http://engine:8787/discord/guilds');
  });

  it('stores a guild config with PUT', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ guildId: 'g1', alertChannelId: 'c2' }),
    });

    const config = await new EngineClient('http://engine:8787').setGuildConfig('g1', 'c2', 'user1');

    expect(config.alertChannelId).toBe('c2');
    const [url, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://engine:8787/discord/guilds/g1');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ alertChannelId: 'c2', setupBy: 'user1' });
  });
```

- [x] **Step 2: Update the env test**

In `apps/discord-bot/src/env.test.ts`, remove `DISCORD_ALERT_CHANNEL_ID` from the `REQUIRED` object and replace the missing-variable test with one that targets a still-required variable, then add a test for the now-optional guild id:

```typescript
  it('throws a named error when a variable is missing', async () => {
    // Failing loudly at startup beats a bot that logs in fine and then
    // silently does nothing because a URL was undefined.
    delete process.env.ENGINE_WS_URL;

    await expect(import('./env')).rejects.toThrow('ENGINE_WS_URL');
  });

  it('treats DISCORD_GUILD_ID as an optional dev convenience', async () => {
    // Commands register globally so the bot works in servers it has never
    // seen. A dev guild id, when present, additionally registers there for
    // instant availability instead of waiting for global propagation.
    delete process.env.DISCORD_GUILD_ID;

    const { env } = await import('./env');

    expect(env.devGuildId).toBeUndefined();
  });
```

Also remove `DISCORD_ALERT_CHANNEL_ID: 'channel1',` from `REQUIRED` and drop the `expect(env.alertChannelId)` assertion from the first test.

- [x] **Step 3: Run and confirm both fail**

Run: `pnpm --filter @cryptonix/discord-bot test`
Expected: FAIL — `listGuildConfigs is not a function`, and `env.devGuildId` undefined because the property does not exist yet

- [x] **Step 4: Implement the client methods**

Add to `apps/discord-bot/src/engine/client.ts`:

```typescript
export interface GuildConfig {
  guildId: string;
  alertChannelId: string;
  setupBy: string | null;
  setupAt: string;
}
```

and inside the `EngineClient` class:

```typescript
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
```

- [x] **Step 5: Implement the env change**

In `apps/discord-bot/src/env.ts`, replace the exported `env` object with:

```typescript
export const env = {
  discordToken: required('DISCORD_TOKEN'),
  discordClientId: required('DISCORD_CLIENT_ID'),
  // Optional. Commands register globally so the bot works in any server;
  // when this is set they ALSO register to that one guild, which Discord
  // makes available instantly rather than after global propagation.
  devGuildId: process.env.DISCORD_GUILD_ID || undefined,
  engineHttpUrl: required('ENGINE_HTTP_URL'),
  engineWsUrl: required('ENGINE_WS_URL'),
};
```

`DISCORD_ALERT_CHANNEL_ID` is deliberately gone — routing lives in `discord_guilds` now, per server.

- [x] **Step 6: Run and confirm it passes**

Run: `pnpm --filter @cryptonix/discord-bot test`
Expected: PASS — 37 tests

- [x] **Step 7: Commit**

```bash
git add apps/discord-bot/src/engine apps/discord-bot/src/env.ts apps/discord-bot/src/env.test.ts
git commit -m "discord-bot: add guild config client, drop single-channel env"
```

---

### Task 4: bot — guild config cache

**Files:**
- Create: `apps/discord-bot/src/guilds/config-cache.ts`
- Test: `apps/discord-bot/src/guilds/config-cache.test.ts`

**Interfaces:**
- Consumes: `EngineClient.listGuildConfigs` (Task 3).
- Produces:
  ```typescript
  export class GuildConfigCache {
    constructor(engine: Pick<EngineClient, 'listGuildConfigs'>)
    load(): Promise<void>
    set(guildId: string, alertChannelId: string): void
    remove(guildId: string): void
    entries(): { guildId: string; alertChannelId: string }[]
  }
  ```
  Tasks 5 and 7 consume it.

**Why a cache at all:** alerts arrive on a socket and must be posted immediately. Asking the engine for routing on every alert adds a round trip to the hot path and makes the bot useless the moment the engine blips — exactly when a buffered alert most needs delivering. The map is small (one row per server) and only changes when someone runs `/setup`.

- [x] **Step 1: Write the failing tests**

Create `apps/discord-bot/src/guilds/config-cache.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { GuildConfigCache } from './config-cache';

describe('GuildConfigCache', () => {
  it('loads existing configs from the engine', async () => {
    const engine = {
      listGuildConfigs: vi.fn().mockResolvedValue([
        { guildId: 'g1', alertChannelId: 'c1' },
        { guildId: 'g2', alertChannelId: 'c2' },
      ]),
    } as any;
    const cache = new GuildConfigCache(engine);

    await cache.load();

    expect(cache.entries()).toHaveLength(2);
  });

  it('reflects a /setup without waiting for a reload', () => {
    const cache = new GuildConfigCache({ listGuildConfigs: vi.fn() } as any);

    cache.set('g1', 'c1');

    expect(cache.entries()).toEqual([{ guildId: 'g1', alertChannelId: 'c1' }]);
  });

  it('overwrites a guild rather than duplicating it', () => {
    const cache = new GuildConfigCache({ listGuildConfigs: vi.fn() } as any);

    cache.set('g1', 'c1');
    cache.set('g1', 'c2');

    expect(cache.entries()).toEqual([{ guildId: 'g1', alertChannelId: 'c2' }]);
  });

  it('drops a guild on remove', () => {
    const cache = new GuildConfigCache({ listGuildConfigs: vi.fn() } as any);
    cache.set('g1', 'c1');

    cache.remove('g1');

    expect(cache.entries()).toHaveLength(0);
  });

  it('survives the engine being down at startup', async () => {
    // The bot must still log in and serve /setup when the engine is not up
    // yet; an empty routing table is recoverable, a crash loop is not.
    const engine = { listGuildConfigs: vi.fn().mockRejectedValue(new Error('engine unreachable')) } as any;
    const cache = new GuildConfigCache(engine);

    await expect(cache.load()).resolves.toBeUndefined();
    expect(cache.entries()).toHaveLength(0);
  });
});
```

- [x] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @cryptonix/discord-bot test -- config-cache`
Expected: FAIL — cannot find module `./config-cache`

- [x] **Step 3: Implement**

Create `apps/discord-bot/src/guilds/config-cache.ts`:

```typescript
import type { EngineClient } from '../engine/client.js';

/**
 * Guild → alert channel, held in memory because alerts arrive on a socket and
 * must be posted immediately. Querying the engine per alert would put a round
 * trip on the hot path and make the bot useless exactly when the engine is
 * struggling. One entry per server, changed only by /setup.
 */
export class GuildConfigCache {
  private channels = new Map<string, string>();

  constructor(private engine: Pick<EngineClient, 'listGuildConfigs'>) {}

  async load(): Promise<void> {
    try {
      const configs = await this.engine.listGuildConfigs();
      this.channels = new Map(configs.map((config) => [config.guildId, config.alertChannelId]));
    } catch (err) {
      // Starting with an empty table is recoverable — /setup repopulates it,
      // and the next load() picks up the rest. Crashing here would put the bot
      // in a restart loop whenever the engine came up second.
      console.error('could not load guild configs; starting with none', err);
    }
  }

  set(guildId: string, alertChannelId: string) {
    this.channels.set(guildId, alertChannelId);
  }

  remove(guildId: string) {
    this.channels.delete(guildId);
  }

  entries() {
    return [...this.channels].map(([guildId, alertChannelId]) => ({ guildId, alertChannelId }));
  }
}
```

- [x] **Step 4: Run and confirm it passes**

Run: `pnpm --filter @cryptonix/discord-bot test -- config-cache`
Expected: PASS — 5 tests

- [x] **Step 5: Commit**

```bash
git add apps/discord-bot/src/guilds
git commit -m "discord-bot: add guild config cache"
```

---

### Task 5: bot — `/setup` command

**Files:**
- Create: `apps/discord-bot/src/commands/setup.ts`
- Modify: `apps/discord-bot/src/commands/types.ts`
- Modify: `apps/discord-bot/src/commands/commands.test.ts`

**Interfaces:**
- Consumes: `EngineClient.setGuildConfig` (Task 3), `GuildConfigCache.set` (Task 4).
- Produces: `setupCommand: BotCommand`. `CommandDeps` gains `guildConfigs: GuildConfigCache`.

**Behaviour:**
- `/setup [channel]` — omitting the channel uses the channel the command was run in, so the common case is typing `/setup` and nothing else.
- Restricted with `setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)`; without it any member could redirect the alert feed.
- Writes through the engine first, and only updates the cache once that succeeds — a cache entry pointing at a channel the engine does not know about would survive until restart and then silently vanish.

- [x] **Step 1: Extend `CommandDeps`**

In `apps/discord-bot/src/commands/types.ts`:

```typescript
import type { GuildConfigCache } from '../guilds/config-cache.js';

export interface CommandDeps {
  engine: EngineClient;
  guildConfigs: GuildConfigCache;
}
```

- [x] **Step 2: Write the failing tests**

The existing fake interaction in `commands.test.ts` has no guild or channel. Add a second builder next to it, then the tests:

```typescript
function fakeGuildInteraction(options: { channel?: string | null; guildId?: string | null }) {
  const editReply = vi.fn();
  return {
    editReply,
    interaction: {
      guildId: options.guildId === undefined ? 'g1' : options.guildId,
      channelId: 'current-channel',
      user: { id: 'user1' },
      options: {
        getChannel: () => (options.channel ? { id: options.channel } : null),
      },
      deferReply: vi.fn(),
      editReply,
    } as any,
  };
}

describe('/setup', () => {
  it('stores the named channel for this guild', async () => {
    const engine = { setGuildConfig: vi.fn().mockResolvedValue({ guildId: 'g1', alertChannelId: 'chosen' }) } as any;
    const guildConfigs = { set: vi.fn() } as any;
    const { interaction } = fakeGuildInteraction({ channel: 'chosen' });

    await setupCommand.execute(interaction, { engine, guildConfigs });

    expect(engine.setGuildConfig).toHaveBeenCalledWith('g1', 'chosen', 'user1');
    expect(guildConfigs.set).toHaveBeenCalledWith('g1', 'chosen');
  });

  it('defaults to the channel the command was run in', async () => {
    // The whole point of "auto setup": typing /setup with no arguments in the
    // channel you want alerts in should just work.
    const engine = { setGuildConfig: vi.fn().mockResolvedValue({}) } as any;
    const { interaction } = fakeGuildInteraction({ channel: null });

    await setupCommand.execute(interaction, { engine, guildConfigs: { set: vi.fn() } as any });

    expect(engine.setGuildConfig).toHaveBeenCalledWith('g1', 'current-channel', 'user1');
  });

  it('refuses to run outside a server', async () => {
    const engine = { setGuildConfig: vi.fn() } as any;
    const { interaction, editReply } = fakeGuildInteraction({ channel: null, guildId: null });

    await setupCommand.execute(interaction, { engine, guildConfigs: { set: vi.fn() } as any });

    expect(engine.setGuildConfig).not.toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls[0][0])).toContain('server');
  });

  it('does not update the cache when the engine write fails', async () => {
    // A cache entry the engine never stored would work until the next restart
    // and then silently disappear — the worst kind of bug to diagnose.
    const engine = { setGuildConfig: vi.fn().mockRejectedValue(new EngineError('engine unreachable', 0)) } as any;
    const guildConfigs = { set: vi.fn() } as any;
    const { interaction, editReply } = fakeGuildInteraction({ channel: 'chosen' });

    await setupCommand.execute(interaction, { engine, guildConfigs });

    expect(guildConfigs.set).not.toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls[0][0])).toContain('engine');
  });
});
```

Add `import { setupCommand } from './setup';` to the top of the file, and pass `guildConfigs: {} as any` into the existing `execute` calls for track/untrack/pnl so they still typecheck against the widened `CommandDeps`.

- [x] **Step 3: Run and confirm it fails**

Run: `pnpm --filter @cryptonix/discord-bot test -- commands`
Expected: FAIL — cannot find module `./setup`

- [x] **Step 4: Implement**

Create `apps/discord-bot/src/commands/setup.ts`:

```typescript
import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { describeError, type BotCommand } from './types.js';

export const setupCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Choose which channel Cryptonix posts alerts to in this server')
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Defaults to the channel you run this in')
        .addChannelTypes(ChannelType.GuildText)
    )
    // Without this gate any member could redirect the whole server's alert feed.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, { engine, guildConfigs }) {
    await interaction.deferReply();

    if (!interaction.guildId) {
      await interaction.editReply('⚠️ `/setup` only works inside a server, not in a DM.');
      return;
    }

    // No channel argument means "here" — the common case is typing /setup in
    // the channel you want and nothing else.
    const channelId = interaction.options.getChannel('channel')?.id ?? interaction.channelId;

    try {
      await engine.setGuildConfig(interaction.guildId, channelId, interaction.user.id);
      // Only after the engine has stored it. A cache entry the engine never
      // saw would work until the next restart and then vanish.
      guildConfigs.set(interaction.guildId, channelId);
      await interaction.editReply(`✅ Cryptonix will post alerts to <#${channelId}> in this server.`);
    } catch (err) {
      await interaction.editReply(describeError(err));
    }
  },
};
```

- [x] **Step 5: Run and confirm it passes**

Run: `pnpm --filter @cryptonix/discord-bot test`
Expected: PASS — 41 tests

- [x] **Step 6: Commit**

```bash
git add apps/discord-bot/src/commands
git commit -m "discord-bot: add /setup command for per-server alert routing"
```

---

### Task 6: bot — global command registration

**Files:**
- Modify: `apps/discord-bot/src/commands/registry.ts`

**Interfaces:**
- Consumes: `setupCommand` (Task 5), `env.devGuildId` (Task 3).
- Produces: `registerCommands(token, clientId, devGuildId?)`.

**Why both:** global registration is what makes the bot work in servers it has never seen, but Discord can take up to an hour to propagate it. Registering additionally to a development guild makes commands appear there instantly, which matters when iterating.

- [x] **Step 1: Implement**

Replace the body of `apps/discord-bot/src/commands/registry.ts`:

```typescript
import { REST, Routes } from 'discord.js';
import { trackCommand } from './track.js';
import { untrackCommand } from './untrack.js';
import { pnlCommand } from './pnl.js';
import { setupCommand } from './setup.js';
import type { BotCommand } from './types.js';

export const commands: BotCommand[] = [setupCommand, trackCommand, untrackCommand, pnlCommand];

export async function registerCommands(token: string, clientId: string, devGuildId?: string): Promise<void> {
  const rest = new REST().setToken(token);
  const body = commands.map((command) => command.data.toJSON());

  // Global registration is what lets the bot work in servers it has never
  // seen. Discord can take up to an hour to propagate it.
  await rest.put(Routes.applicationCommands(clientId), { body });

  // A dev guild, when configured, gets the same commands immediately, so
  // iteration does not wait on global propagation.
  if (devGuildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, devGuildId), { body });
  }
}

// `pnpm --filter @cryptonix/discord-bot register-commands` runs this file directly.
if (process.argv[1]?.endsWith('registry.ts') || process.argv[1]?.endsWith('registry.js')) {
  const { env } = await import('../env.js');
  await registerCommands(env.discordToken, env.discordClientId, env.devGuildId);
  console.log(
    `Registered ${commands.length} slash commands globally` +
      (env.devGuildId ? ` and to dev guild ${env.devGuildId}` : '')
  );
}
```

- [x] **Step 2: Run the suite**

Run: `pnpm --filter @cryptonix/discord-bot test`
Expected: PASS — 41 tests, unchanged

- [x] **Step 3: Commit**

```bash
git add apps/discord-bot/src/commands/registry.ts
git commit -m "discord-bot: register commands globally with optional dev guild"
```

---

### Task 7: bot — alert fan-out and join prompt

**Files:**
- Modify: `apps/discord-bot/src/index.ts`
- Create: `apps/discord-bot/src/guilds/fan-out.ts`
- Test: `apps/discord-bot/src/guilds/fan-out.test.ts`

**Interfaces:**
- Consumes: `GuildConfigCache` (Task 4), `buildWalletTradeMessage` / `isWalletAlertPayload` (bot v1 Task 8).
- Produces:
  ```typescript
  export async function fanOutAlert(
    alert: AlertEvent,
    cache: Pick<GuildConfigCache, 'entries'>,
    sendToChannel: (channelId: string, message: unknown) => Promise<void>
  ): Promise<void>
  ```

**Why fan-out is its own file rather than a closure in `index.ts`:** it holds the rule that one server's failure must not affect another's, which is the part most worth testing, and `index.ts` is wiring that cannot be unit-tested without a live Discord client.

- [x] **Step 1: Write the failing tests**

Create `apps/discord-bot/src/guilds/fan-out.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { fanOutAlert } from './fan-out';

const walletAlert = {
  type: 'wallet_buy',
  refId: 1,
  payload: {
    walletId: 1,
    walletLabel: 'Whale',
    mint: 'Mint1',
    side: 'buy' as const,
    solAmount: 2.5,
    tokenAmount: 1000,
    axiomLink: 'https://axiom.trade/t/Mint1',
  },
};

function cacheOf(...guilds: [string, string][]) {
  return { entries: () => guilds.map(([guildId, alertChannelId]) => ({ guildId, alertChannelId })) };
}

describe('fanOutAlert', () => {
  it('posts to every configured guild', async () => {
    const send = vi.fn().mockResolvedValue(undefined);

    await fanOutAlert(walletAlert, cacheOf(['g1', 'c1'], ['g2', 'c2']), send);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((c) => c[0])).toEqual(['c1', 'c2']);
  });

  it('keeps delivering when one guild fails', async () => {
    // A revoked permission in one server must not cost every other server its
    // alerts. This is the whole reason fan-out is isolated per guild.
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('missing permissions'))
      .mockResolvedValueOnce(undefined);

    await fanOutAlert(walletAlert, cacheOf(['g1', 'c1'], ['g2', 'c2']), send);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('ignores alert types this version does not render', async () => {
    const send = vi.fn();

    await fanOutAlert({ type: 'tweet', refId: 2, payload: {} }, cacheOf(['g1', 'c1']), send);

    expect(send).not.toHaveBeenCalled();
  });

  it('ignores a wallet alert with an unexpected payload', async () => {
    const send = vi.fn();

    await fanOutAlert({ type: 'wallet_buy', refId: 3, payload: { nope: true } }, cacheOf(['g1', 'c1']), send);

    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing when no guild has run /setup', async () => {
    const send = vi.fn();

    await fanOutAlert(walletAlert, cacheOf(), send);

    expect(send).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @cryptonix/discord-bot test -- fan-out`
Expected: FAIL — cannot find module `./fan-out`

- [x] **Step 3: Implement**

Create `apps/discord-bot/src/guilds/fan-out.ts`:

```typescript
import type { AlertEvent } from '../engine/alert-stream.js';
import type { GuildConfigCache } from './config-cache.js';
import { buildWalletTradeMessage, isWalletAlertPayload } from '../embeds/wallet-buy.js';

export async function fanOutAlert(
  alert: AlertEvent,
  cache: Pick<GuildConfigCache, 'entries'>,
  sendToChannel: (channelId: string, message: unknown) => Promise<void>
): Promise<void> {
  // Phase 3 puts tweet and new-coin alerts on this same socket. Skip quietly
  // rather than rendering something this version does not understand.
  if (alert.type !== 'wallet_buy' && alert.type !== 'wallet_sell') return;
  if (!isWalletAlertPayload(alert.payload)) {
    console.error(`alert ${alert.refId} has an unexpected payload shape; skipping`);
    return;
  }

  const message = buildWalletTradeMessage(alert.payload);

  // Sequential and individually guarded: one server with revoked permissions
  // or a deleted channel must not cost every other server its alerts.
  for (const { guildId, alertChannelId } of cache.entries()) {
    try {
      await sendToChannel(alertChannelId, message);
    } catch (err) {
      console.error(`failed to post alert to guild ${guildId} channel ${alertChannelId}`, err);
    }
  }
}
```

- [x] **Step 4: Rewrite the entrypoint**

Replace `apps/discord-bot/src/index.ts`:

```typescript
import { Client, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { env } from './env.js';
import { EngineClient } from './engine/client.js';
import { AlertStream } from './engine/alert-stream.js';
import { GuildConfigCache } from './guilds/config-cache.js';
import { fanOutAlert } from './guilds/fan-out.js';
import { commands } from './commands/registry.js';
import { describeError } from './commands/types.js';

const engine = new EngineClient(env.engineHttpUrl);
const guildConfigs = new GuildConfigCache(engine);
const commandsByName = new Map(commands.map((command) => [command.data.name, command]));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = commandsByName.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, { engine, guildConfigs });
  } catch (err) {
    console.error(`command ${interaction.commandName} failed`, err);
    const message = describeError(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

// Joining a server is the moment someone is most likely to be looking. Point
// them at /setup rather than leaving a silent bot that never posts.
client.on(Events.GuildCreate, async (guild) => {
  const me = guild.members.me;
  const channel = guild.channels.cache.find(
    (c) => c.isTextBased() && me !== null && c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) === true
  );
  if (!channel?.isTextBased() || !('send' in channel)) return;

  await channel
    .send(
      'Thanks for adding **Cryptonix**. Run `/setup` in the channel you want alerts in — ' +
        'or `/setup channel:#some-channel` to pick a different one. Then `/track wallet` to start following a wallet.'
    )
    .catch(() => {});
});

client.on(Events.GuildDelete, (guild) => {
  // Stop trying to post to a server that removed us.
  guildConfigs.remove(guild.id);
});

const stream = new AlertStream({ url: env.engineWsUrl });

client.once(Events.ClientReady, async (ready) => {
  console.log(`discord bot ready as ${ready.user.tag}`);

  await guildConfigs.load();
  console.log(`loaded alert routing for ${guildConfigs.entries().length} server(s)`);

  stream.onAlert((alert) => {
    void fanOutAlert(alert, guildConfigs, async (channelId, message) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased() || !('send' in channel)) {
        throw new Error(`channel ${channelId} is not a text channel the bot can post to`);
      }
      await channel.send(message as Parameters<typeof channel.send>[0]);
    });
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

- [x] **Step 5: Run and confirm everything passes**

Run: `pnpm --filter @cryptonix/discord-bot test`
Expected: PASS — 46 tests

- [x] **Step 6: Build**

Run: `pnpm build`
Expected: all four packages compile

- [x] **Step 7: Commit**

```bash
git add apps/discord-bot/src
git commit -m "discord-bot: fan out alerts per server, prompt for setup on join"
```

---

### Task 8: full verification

- [x] **Step 1: Run everything fresh**

Run: `pnpm exec turbo run test --force`
Expected: PASS — core 25, db 4, engine 37, discord-bot 46

- [x] **Step 2: Update `.env.example`**

`DISCORD_ALERT_CHANNEL_ID` is no longer read. Replace that line with a comment so anyone copying the file is not misled:

```
DISCORD_TOKEN=your-discord-bot-token-here
DISCORD_CLIENT_ID=your-discord-application-id
# Optional: registers commands to this one guild instantly instead of waiting
# for global propagation. Alert routing is per-server via /setup, not env.
DISCORD_GUILD_ID=your-dev-server-id
ENGINE_HTTP_URL=http://localhost:8787
ENGINE_WS_URL=ws://localhost:8787/ws
```

- [ ] **Step 3: Register commands and start the stack**

```bash
pnpm --filter @cryptonix/discord-bot register-commands
docker start cryptonix-pg
pnpm --filter @cryptonix/engine dev        # terminal 2
pnpm --filter @cryptonix/discord-bot dev   # terminal 3
```

Expected: `Registered 4 slash commands globally and to dev guild …`, then the bot logs `loaded alert routing for 0 server(s)`.

- [ ] **Step 4: Verify setup and alerts in Discord**

1. Run `/setup` in the channel you want alerts in → `✅ Cryptonix will post alerts to #… in this server.`
   plus a **sample alert posted to that channel**, labelled as a sample. That is the delivery path
   proven end to end — permissions, embed, button — before any wallet has traded.
2. `/track wallet address:<a real Solana address> label:Whale`
3. Replay a synthetic Helius delivery (see bot v1 plan, Task 11 Step 7) → the embed appears in the channel you chose.
4. Run `/setup channel:#somewhere-else`, replay again → the embed now arrives in the new channel.
5. Add the bot to a second server, run `/setup` there, replay once more → **both** servers receive the same alert, each in its own channel.
6. In the second server, run `/status` → it reports that server's own channel,
   not the first one's. The routing is per-server; the wallet list is not.
7. Kick the bot from the second server, then re-invite it → it posts the
   onboarding message again, and `/status` there says it is not set up until
   you run `/setup` a second time. Its old routing row should not have
   survived: that is what GuildDelete and the startup reconciliation are for.

- [x] **Step 5: Commit**

```bash
git add .env.example
git commit -m "Document per-server setup in .env.example"
```

---

## What you'll be able to see after this plan

- The bot works in any server it is invited to, with no redeploy and no env change.
- `/setup` in a channel routes that server's alerts there; running it again moves them.
- One tracked wallet's trade posts to every configured server at once, each in its own channel, and a broken channel in one server costs the others nothing.
- Wallets added from Discord, `curl`, or the Phase 4 desktop app are the same list — there is no sync step because there is nothing to sync.

## Next plan

Phase 3, **Signals** (spec §11.3). The fan-out already skips alert types it does not recognise, so `tweet` and `new_coin` alerts can be added to the engine and rendered by new embed modules without touching the wallet path or the routing table.
