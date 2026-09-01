import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '@cryptonix/db';
import { wallets, walletTrades, pnlDaily, discordGuilds, alerts, clientState, scannedCoins } from '@cryptonix/db';
import type { HeliusEnhancedTransaction } from '@cryptonix/core';
import type { WalletMonitor } from '../monitors/wallet-monitor.js';
import type { PnlTracker } from '../monitors/pnl-tracker.js';
import type { AlertBus } from './alert-bus.js';
import type { SolanaRpcClient } from '../solana/balance.js';
import { isValidSolanaAddress } from '../solana/address.js';
import { isValidBearer } from './auth.js';
import { HeliusError } from '../helius/client.js';

const MAX_LABEL_LENGTH = 100;
/** Cap on a single catch-up page, so a long outage cannot flood a channel. */
const MAX_ALERT_REPLAY = 50;
/**
 * Most alerts one /alerts/recent page will return.
 *
 * Matches the desktop rail's own cap: asking for more than it can hold would
 * only waste a round trip.
 */
const MAX_RECENT_ALERTS = 200;
const MAX_STATE_VALUE_LENGTH = 1_000;
const MAX_COIN_PAGE = 200;
/**
 * How long an alert must have existed before the replay endpoint will serve
 * it. Covers the window where a higher serial id is visible while a lower one
 * is still uncommitted. The live socket is unaffected.
 */
const ALERT_SETTLE_MS = 5_000;

/**
 * Express 4 does not forward a rejected promise from an async handler to its
 * error middleware — the rejection escapes as an unhandled rejection, which
 * under Node's default policy terminates the process, and the client's request
 * hangs forever. For a service meant to run 24/7 that turns one bad request
 * (e.g. a scanner hitting /wallets/foo/trades) into an outage, so every async
 * route goes through this wrapper.
 */
function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    handler(req, res).catch((err) => {
      console.error(`api: unhandled error on ${req.method} ${req.originalUrl}`, err);
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    });
  };
}

/** Returns the parsed id, or null after having already sent a 400. */
function parseWalletId(req: Request, res: Response): number | null {
  const walletId = Number(req.params.id);
  if (!Number.isInteger(walletId) || walletId < 1) {
    res.status(400).json({ error: 'wallet id must be a positive integer' });
    return null;
  }
  return walletId;
}

/**
 * Discord snowflakes are 17-20 digit decimal strings. Express types a route
 * param as `string | string[]` (a repeated param arrives as an array), so this
 * both narrows the type and keeps junk out of discord_guilds — the id is a
 * primary key, and anything that reaches this route can write one.
 */
function parseGuildId(req: Request, res: Response): string | null {
  const raw = req.params.guildId;
  const guildId = typeof raw === 'string' ? raw : '';
  if (!/^\d{17,20}$/.test(guildId)) {
    res.status(400).json({ error: 'guild id must be a Discord snowflake' });
    return null;
  }
  return guildId;
}

/**
 * Keys are chosen by clients, so they are bounded and restricted to characters
 * that cannot be confused with a path segment.
 */
function parseStateKey(req: Request, res: Response): string | null {
  const raw = req.params.key;
  const key = typeof raw === 'string' ? raw : '';
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(key)) {
    res.status(400).json({ error: 'key must be 1-120 characters of A-Z a-z 0-9 . _ : -' });
    return null;
  }
  return key;
}

/**
 * Constant-time comparison of the incoming Authorization header against the
 * webhook secret. A plain `===` short-circuits on the first differing byte,
 * which leaks timing information an attacker can use to guess the secret
 * character-by-character; timingSafeEqual does not. It throws on
 * differing-length buffers instead of returning false, so the length check
 * has to happen first.
 */
function isValidWebhookAuth(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const received = Buffer.from(header);
  const expected = Buffer.from(secret);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

/**
 * Gate for every route except /webhooks/helius.
 *
 * WEBHOOK_BASE_URL has to be publicly reachable for Helius to deliver at all,
 * which puts this entire API on the internet. Unauthenticated, that means
 * anyone who finds the host can read every tracked wallet, register wallets
 * (burning the free-tier webhook cap and Helius credits), DELETE a wallet
 * along with trade rows that live delivery cannot rebuild, or repoint a
 * Discord server's alert routing.
 *
 * /webhooks/helius is exempt because Helius only ever knows the webhook
 * secret; it authenticates itself with that instead (see isValidWebhookAuth).
 */
function requireAuth(apiKey: string, webhookSecret: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    // The webhook route authenticates with the shared secret Helius echoes
    // back, not the API key. Checking it HERE rather than only inside the
    // route means a forged delivery is rejected before body-parser reads and
    // parses up to 2mb of attacker-supplied JSON. The route keeps its own
    // check as defence in depth.
    if (req.path.startsWith('/webhooks/')) {
      if (!isValidWebhookAuth(req.header('authorization'), webhookSecret)) {
        res.status(401).json({ error: 'invalid webhook authorization' });
        return;
      }
      return next();
    }

    if (!isValidBearer(req.header('authorization'), apiKey)) {
      res.status(401).json({ error: 'missing or invalid API key' });
      return;
    }
    next();
  };
}

export function createServer(
  db: Db,
  walletMonitor: WalletMonitor,
  pnlTracker: PnlTracker,
  _alertBus: AlertBus,
  solanaRpc: Pick<SolanaRpcClient, 'getBalanceSol'>,
  webhookSecret: string,
  apiKey: string,
  /** Injectable so tests need not wait out the window; see ALERT_SETTLE_MS. */
  alertSettleMs: number = ALERT_SETTLE_MS
): Express {
  // An empty key would be catastrophic rather than merely permissive: two
  // zero-length buffers compare equal, so `Authorization: Bearer ` with no
  // value would authenticate every request. Fail at startup instead.
  if (!apiKey) throw new Error('createServer requires a non-empty apiKey');

  /**
   * Wallets whose PnL recompute failed and must be retried.
   *
   * Recomputing for every wallet a batch mentions is what makes the 500 ->
   * Helius-redelivery retry work at all, but doing it on EVERY redelivery
   * re-walks a long-history wallet's whole trade table inline before the 200,
   * which can exceed Helius's own delivery timeout. Remembering the failures
   * restores the cheap path for an ordinary duplicate while still retrying the
   * ones that actually need it.
   */
  const walletsNeedingRecompute = new Set<number>();

  const app = express();

  /*
   * CORS, and why it has to come before auth.
   *
   * The desktop app is a web page inside a webview, and its origin is never
   * the engine's: `http://tauri.localhost` on Windows, `tauri://localhost` on
   * macOS, `http://localhost:5173` in development. Without these headers the
   * browser blocks every REST response and the app shows nothing but "cannot
   * reach the engine" — while the WebSocket, which CORS does not govern,
   * connects perfectly and makes it look like a server problem.
   *
   * `*` is the right origin here and not a weakening: this API carries no
   * cookies and no ambient authority, so a request from a hostile page simply
   * arrives without the key and is refused. Credentials are deliberately NOT
   * allowed, which is also what makes `*` legal.
   *
   * The preflight must answer before requireAuth: a browser sends OPTIONS with
   * no Authorization header at all, so authenticating it would 401 every
   * preflight and block the request it was asking about.
   */
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Auth first, parser second. With the parser mounted first, a malformed body
  // from an UNAUTHENTICATED caller reached body-parser, threw, and fell through
  // to Express's default error handler — which renders an HTML stack trace
  // containing absolute filesystem paths and pinned dependency versions. This
  // engine is publicly reachable by design, so that was handing reconnaissance
  // to anyone. Both credentials are checked here, so no unauthenticated body
  // reaches the parser on any route.
  app.use(requireAuth(apiKey, webhookSecret));

  // Helius delivers enhanced transactions in batches; a busy wallet's batch
  // comfortably exceeds express.json()'s 100kb default. Rejecting one with 413
  // would make Helius retry the same oversized batch forever and those trades
  // would never land.
  app.use(express.json({ limit: '2mb' }));

  app.get('/wallets', asyncRoute(async (_req, res) => {
    res.json(await db.select().from(wallets));
  }));

  app.post('/wallets', asyncRoute(async (req, res) => {
    const { address, label, isMine } = (req.body ?? {}) as { address?: unknown; label?: unknown; isMine?: unknown };
    // typeof, not truthiness: `[]` and `{}` are both truthy and both have a
    // `.length` that clears the cap below (0 and undefined), so a non-string
    // label used to reach the database and get echoed into embeds as '' or
    // '[object Object]'.
    if (typeof address !== 'string' || typeof label !== 'string' || !address || !label) {
      res.status(400).json({ error: 'address and label are required, and must be strings' });
      return;
    }
    // trackWallet registers a Helius webhook before writing anything, and the
    // free tier caps how many addresses may have one. An invalid address would
    // consume a slot permanently and then never fire.
    if (!isValidSolanaAddress(address)) {
      res.status(400).json({ error: 'address is not a valid Solana public key' });
      return;
    }
    // The label is free text stored in an unbounded column and echoed into
    // Discord embeds; cap it rather than letting a megabyte through.
    if (label.length > MAX_LABEL_LENGTH) {
      res.status(400).json({ error: `label must be ${MAX_LABEL_LENGTH} characters or fewer` });
      return;
    }
    let tracked;
    try {
      tracked = await walletMonitor.trackWallet(address, label, Boolean(isMine));
    } catch (err) {
      if (err instanceof HeliusError) {
        // Pass Helius's own explanation through. The common cause is a
        // WEBHOOK_BASE_URL that Helius cannot reach (localhost, or plain http),
        // and "internal error" would send the operator hunting in the wrong place.
        res.status(502).json({ error: `Helius rejected the webhook registration: ${err.message}` });
        return;
      }
      throw err;
    }
    const { wallet, created, healed } = tracked;
    if (!created && !healed) {
      // Already tracked and healthy. 409 with the existing row lets the caller
      // say so plainly instead of surfacing a constraint violation as a 500.
      res.status(409).json({ error: 'wallet is already tracked', wallet });
      return;
    }

    // 200 rather than 201 for a heal: the row already existed, we repaired it.
    res.status(created ? 201 : 200).json(wallet);

    // A new wallet needs its history. So does a healed one — it reached us
    // mid-repair and its trades may be partly gone. An untouched, healthy
    // wallet does not: re-running the backfill would burn Helius quota
    // re-fetching rows we already hold.
    pnlTracker.backfillWallet(wallet.id, wallet.address).catch((err) => {
      console.error(`pnl backfill failed for wallet ${wallet.id}`, err);
    });
  }));

  /**
   * Rename a wallet, or change whether it is one of yours.
   *
   * Deliberately separate from tracking: the only way to fix a mislabelled
   * wallet used to be untracking it, which deletes its trades and its PnL and
   * then costs a fresh Helius backfill to get back. A label is a note to
   * yourself and must be editable without touching the history under it.
   *
   * The address is not editable. Changing it would silently point a wallet's
   * whole recorded history at a different account.
   */
  app.patch(
    '/wallets/:id',
    asyncRoute(async (req, res) => {
      const walletId = parseWalletId(req, res);
      if (walletId === null) return;

      const { label, isMine } = (req.body ?? {}) as { label?: unknown; isMine?: unknown };
      if (label === undefined && isMine === undefined) {
        res.status(400).json({ error: 'nothing to change: pass label, isMine, or both' });
        return;
      }

      const update: { label?: string; isMine?: boolean } = {};
      if (label !== undefined) {
        // Same rules as tracking: this label goes to the same embeds.
        if (typeof label !== 'string' || label.trim() === '') {
          res.status(400).json({ error: 'label must be a non-empty string' });
          return;
        }
        if (label.length > MAX_LABEL_LENGTH) {
          res.status(400).json({ error: `label must be ${MAX_LABEL_LENGTH} characters or fewer` });
          return;
        }
        update.label = label;
      }
      if (isMine !== undefined) {
        // Not Boolean(): coercing would turn a typo like "false" into true.
        if (typeof isMine !== 'boolean') {
          res.status(400).json({ error: 'isMine must be a boolean' });
          return;
        }
        update.isMine = isMine;
      }

      const [updated] = await db.update(wallets).set(update).where(eq(wallets.id, walletId)).returning();
      if (!updated) {
        res.status(404).json({ error: 'wallet not found' });
        return;
      }
      res.json(updated);
    })
  );

  app.get('/wallets/:id/trades', asyncRoute(async (req, res) => {
    const walletId = parseWalletId(req, res);
    if (walletId === null) return;
    res.json(await db.select().from(walletTrades).where(eq(walletTrades.walletId, walletId)).orderBy(walletTrades.ts));
  }));

  app.get('/wallets/:id/pnl', asyncRoute(async (req, res) => {
    const walletId = parseWalletId(req, res);
    if (walletId === null) return;
    res.json(await db.select().from(pnlDaily).where(eq(pnlDaily.walletId, walletId)));
  }));

  app.get(
    '/wallets/:id/balance',
    asyncRoute(async (req, res) => {
      const walletId = parseWalletId(req, res);
      if (walletId === null) return;
      const [wallet] = await db.select().from(wallets).where(eq(wallets.id, walletId));
      if (!wallet) {
        res.status(404).json({ error: 'wallet not found' });
        return;
      }
      const sol = await solanaRpc.getBalanceSol(wallet.address);
      res.json({ walletId, sol });
    })
  );

  app.delete(
    '/wallets/:id',
    asyncRoute(async (req, res) => {
      const walletId = parseWalletId(req, res);
      if (walletId === null) return;
      let removed: boolean;
      try {
        removed = await walletMonitor.untrackWallet(walletId);
      } catch (err) {
        if (err instanceof HeliusError) {
          // The wallet row deliberately survives a failed webhook release, so
          // the operator can retry rather than leaving a live webhook nothing
          // references. Say that, instead of a bare "internal error".
          res.status(502).json({
            error: `Helius refused to release the webhook, so the wallet is still tracked: ${err.message}`,
          });
          return;
        }
        throw err;
      }
      if (!removed) {
        res.status(404).json({ error: 'wallet not found' });
        return;
      }
      res.status(204).end();
    })
  );

  /**
   * Alerts after `since`, oldest first.
   *
   * The WebSocket only reaches clients connected at the moment an alert is
   * published. A trade landing while the bot is restarting or inside its
   * reconnect backoff was written to the alerts table and then never
   * delivered. This is how a reconnecting client catches up on what it missed.
   */
  app.get(
    '/alerts',
    asyncRoute(async (req, res) => {
      // A repeated query param (?since=1&since=2) arrives as an array. Coercing
      // that to 0 silently returned the 50 OLDEST alerts instead of rejecting
      // it — a caller resuming from there would replay history.
      // ?? only covers undefined, so `?since=` (empty value) slipped through
      // as '' and Number('') is 0 — returning the OLDEST alerts to a caller
      // that asked to resume, which is exactly the history replay this
      // validation exists to prevent. A repeated param arrives as an array.
      const sinceRaw = req.query.since === undefined ? '0' : req.query.since;
      if (typeof sinceRaw !== 'string' || sinceRaw.trim() === '') {
        res.status(400).json({ error: 'since must be a single non-negative integer' });
        return;
      }
      const since = Number(sinceRaw);
      if (!Number.isInteger(since) || since < 0) {
        res.status(400).json({ error: 'since must be a non-negative integer' });
        return;
      }

      // Only rows old enough that any lower id has certainly committed.
      //
      // Postgres allocates a serial before the transaction commits, so alert
      // 101 can be visible while 100 is still in flight. A client walking in
      // that window advances its cursor to 101, and 100 -- which it also never
      // saw live -- becomes unreachable, since the filter is strictly `> since`.
      //
      // The comparison happens in SQL, against the database's own clock.
      // alerts.ts is `timestamp without time zone` written by now(), so it
      // carries the session's local wall clock; comparing it to a bound
      // derived from Node's Date.now() made every row look unsettled for the
      // whole UTC offset on a database east of UTC — catch-up would return
      // empty pages and silently deliver nothing for hours.
      const rows = await db
        .select()
        .from(alerts)
        .where(
          and(
            gt(alerts.id, since),
            sql`${alerts.ts} < now() - make_interval(secs => ${alertSettleMs / 1000})`
          )
        )
        .orderBy(alerts.id)
        .limit(MAX_ALERT_REPLAY);
      res.json(rows);
    })
  );

  /**
   * The newest alert id, or 0 when there are none.
   *
   * A client starting fresh needs this to resume from "now" rather than
   * replaying history. It cannot be derived from GET /alerts: that returns an
   * ascending, capped page, so asking with since=0 yields the OLDEST rows.
   */
  /**
   * Coins the scanner has alerted, strongest first.
   *
   * Feeds the desktop app's Coins tab (spec §5.3). Only alerted coins: the
   * table also holds everything considered and rejected, which is scanner
   * bookkeeping rather than something to show a user.
   */
  app.get(
    '/coins',
    asyncRoute(async (req, res) => {
      const limitRaw = req.query.limit === undefined ? '50' : req.query.limit;
      if (typeof limitRaw !== 'string') {
        res.status(400).json({ error: 'limit must be a single integer' });
        return;
      }
      const limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_COIN_PAGE) {
        res.status(400).json({ error: `limit must be an integer between 1 and ${MAX_COIN_PAGE}` });
        return;
      }

      const rows = await db
        .select()
        .from(scannedCoins)
        .where(eq(scannedCoins.alerted, true))
        .orderBy(desc(scannedCoins.momentumScore), desc(scannedCoins.firstSeenAt))
        .limit(limit);
      res.json(rows);
    })
  );

  /**
   * The newest alerts, most recent first.
   *
   * A viewer wants a window on what just happened; GET /alerts answers a
   * different question — "everything after this cursor" — and because that
   * page is ascending and capped, a client starting at 0 got the fifty OLDEST
   * alerts in the whole history. The desktop rail did exactly that and opened
   * on ancient trades.
   *
   * Deliberately not a cursor: this endpoint is for clients that may miss an
   * alert with no consequence. Anything that must deliver every alert exactly
   * once uses /alerts and /alerts/head instead.
   */
  app.get(
    '/alerts/recent',
    asyncRoute(async (req, res) => {
      const limitRaw = req.query.limit === undefined ? '50' : req.query.limit;
      if (typeof limitRaw !== 'string') {
        res.status(400).json({ error: 'limit must be a single integer' });
        return;
      }
      const limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1) {
        res.status(400).json({ error: 'limit must be a positive integer' });
        return;
      }

      const rows = await db
        .select()
        .from(alerts)
        // The same settle window as /alerts: a row whose lower-id sibling has
        // not committed yet would otherwise appear, and disappear on a reload.
        .where(sql`${alerts.ts} < now() - make_interval(secs => ${alertSettleMs / 1000})`)
        .orderBy(desc(alerts.id))
        .limit(Math.min(limit, MAX_RECENT_ALERTS));
      res.json(rows);
    })
  );

  app.get(
    '/alerts/head',
    asyncRoute(async (_req, res) => {
      const [newest] = await db.select().from(alerts).orderBy(desc(alerts.id)).limit(1);
      res.json({ id: newest?.id ?? 0 });
    })
  );

  /**
   * Small key/value store for consumer state, so a client can survive its own
   * restart. The bot keeps its alert-replay cursor here; without it the cursor
   * reset to the head on every start and alerts published while the bot was
   * down were never replayed.
   */
  app.get(
    '/state/:key',
    asyncRoute(async (req, res) => {
      const key = parseStateKey(req, res);
      if (key === null) return;
      const [row] = await db.select().from(clientState).where(eq(clientState.key, key));
      res.json({ key, value: row?.value ?? null });
    })
  );

  app.put(
    '/state/:key',
    asyncRoute(async (req, res) => {
      const key = parseStateKey(req, res);
      if (key === null) return;

      const { value } = (req.body ?? {}) as { value?: unknown };
      if (typeof value !== 'string' || value.length > MAX_STATE_VALUE_LENGTH) {
        res.status(400).json({ error: `value must be a string of at most ${MAX_STATE_VALUE_LENGTH} characters` });
        return;
      }

      const [row] = await db
        .insert(clientState)
        .values({ key, value })
        .onConflictDoUpdate({ target: clientState.key, set: { value, updatedAt: new Date() } })
        .returning();
      res.json({ key: row.key, value: row.value });
    })
  );

  app.get(
    '/discord/guilds',
    asyncRoute(async (_req, res) => {
      res.json(await db.select().from(discordGuilds));
    })
  );

  app.put(
    '/discord/guilds/:guildId',
    asyncRoute(async (req, res) => {
      const guildId = parseGuildId(req, res);
      if (guildId === null) return;

      const { alertChannelId, setupBy } = (req.body ?? {}) as { alertChannelId?: unknown; setupBy?: unknown };
      // Same bar as parseGuildId: this row drives every alert for the guild,
      // and a non-string would persist as '[object Object]', permanently
      // breaking fan-out for that server with no obvious cause.
      if (typeof alertChannelId !== 'string' || !/^\d{17,20}$/.test(alertChannelId)) {
        res.status(400).json({ error: 'alertChannelId must be a Discord snowflake' });
        return;
      }
      if (setupBy !== undefined && typeof setupBy !== 'string') {
        res.status(400).json({ error: 'setupBy must be a string when provided' });
        return;
      }

      // Upsert: /setup is idempotent, and re-running it to move channels is
      // expected use, not a conflict.
      const [row] = await db
        .insert(discordGuilds)
        .values({ guildId, alertChannelId, setupBy })
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
      const guildId = parseGuildId(req, res);
      if (guildId === null) return;

      // Idempotent on purpose: the bot calls this when kicked from a server,
      // and Discord may deliver that event more than once.
      await db.delete(discordGuilds).where(eq(discordGuilds.guildId, guildId));
      res.status(204).end();
    })
  );

  app.post('/webhooks/helius', asyncRoute(async (req, res) => {
    // WEBHOOK_BASE_URL is a public URL by design, so anyone can find this
    // endpoint. Helius echoes back the secret we registered (authHeader, see
    // helius/client.ts) as this header on every real delivery; reject
    // anything else before it touches the database.
    if (!isValidWebhookAuth(req.header('authorization'), webhookSecret)) {
      res.status(401).json({ error: 'invalid webhook authorization' });
      return;
    }

    const body = req.body as HeliusEnhancedTransaction | HeliusEnhancedTransaction[];
    // handleWebhookPayload now throws on a batch-level failure (e.g. the
    // tracked-wallets fetch) instead of swallowing it, and asyncRoute turns
    // that into a 500 — letting it propagate here (no try/catch) is
    // intentional, so Helius sees a non-2xx and retries the batch instead of
    // considering lost trades "delivered".
    const { affected, withNewTrades } = await walletMonitor.handleWebhookPayload(
      Array.isArray(body) ? body : [body]
    );

    // Recompute PnL for every wallet this batch is ABOUT — including ones
    // whose trades were already recorded. That is what makes the retry below
    // actually work: on a redelivery every trade looks like a duplicate, so a
    // "new trades only" set was empty and the failed recompute never re-ran.
    //
    // Done BEFORE responding 200: if a recompute throws, we still want Helius
    // to retry the batch (consistent with the batch-failure handling above),
    // rather than reporting success while PnL is left stale.
    // Every wallet is attempted before anything is thrown. Throwing from
    // inside the loop meant a batch touching A and B, where A failed, never
    // reached B -- and on the redelivery B had no new trades and was not in
    // the retry set either, so its pnl_daily stayed permanently stale.
    let recomputeError: unknown = null;
    for (const walletId of affected) {
      const hadNewTrade = withNewTrades.includes(walletId);
      if (!hadNewTrade && !walletsNeedingRecompute.has(walletId)) continue;

      try {
        await pnlTracker.recomputePnl(walletId);
        walletsNeedingRecompute.delete(walletId);
      } catch (err) {
        // Remembered so the redelivery this 500 triggers actually retries it,
        // instead of short-circuiting on "no new trades" and answering 200
        // with pnl_daily left stale.
        walletsNeedingRecompute.add(walletId);
        console.error(`pnl recompute failed for wallet ${walletId}`, err);
        recomputeError ??= err;
      }
    }

    // Rethrown after every wallet has been attempted, so asyncRoute answers
    // 500 and Helius redelivers — the retry the set above depends on.
    if (recomputeError !== null) throw recomputeError;

    res.status(200).send();
  }));

  // Last line of defence. Anything reaching here — a malformed body from an
  // authenticated caller, a payload over the size limit — would otherwise hit
  // Express's default handler, which renders an HTML stack trace with absolute
  // paths and dependency versions. Answer JSON, and say nothing about internals.
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);

    if (err.type === 'entity.too.large') {
      res.status(413).json({ error: 'request body too large' });
      return;
    }
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      res.status(400).json({ error: 'request body is not valid JSON' });
      return;
    }

    console.error('api: unhandled middleware error', err);
    res.status(err.status && err.status < 500 ? err.status : 500).json({ error: 'internal error' });
  });

  return app;
}
