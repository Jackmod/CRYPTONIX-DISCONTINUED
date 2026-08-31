import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '@cryptonix/db';
import { wallets, walletTrades, pnlDaily, discordGuilds } from '@cryptonix/db';
import type { HeliusEnhancedTransaction } from '@cryptonix/core';
import type { WalletMonitor } from '../monitors/wallet-monitor.js';
import type { PnlTracker } from '../monitors/pnl-tracker.js';
import type { AlertBus } from './alert-bus.js';
import type { SolanaRpcClient } from '../solana/balance.js';
import { isValidSolanaAddress } from '../solana/address.js';
import { isValidBearer } from './auth.js';
import { HeliusError } from '../helius/client.js';

const MAX_LABEL_LENGTH = 100;

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
function requireApiKey(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/webhooks/')) return next();

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
  apiKey: string
): Express {
  // An empty key would be catastrophic rather than merely permissive: two
  // zero-length buffers compare equal, so `Authorization: Bearer ` with no
  // value would authenticate every request. Fail at startup instead.
  if (!apiKey) throw new Error('createServer requires a non-empty apiKey');

  const app = express();

  // Auth first, parser second. With the parser mounted first, a malformed body
  // from an UNAUTHENTICATED caller reached body-parser, threw, and fell through
  // to Express's default error handler — which renders an HTML stack trace
  // containing absolute filesystem paths and pinned dependency versions. This
  // engine is publicly reachable by design, so that was handing reconnaissance
  // to anyone. requireApiKey still calls next() for /webhooks/, so Helius
  // deliveries are parsed exactly as before.
  app.use(requireApiKey(apiKey));

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
    const walletIdsWithNewTrades = await walletMonitor.handleWebhookPayload(Array.isArray(body) ? body : [body]);

    // Recompute PnL for every wallet that got a live trade, and do it BEFORE
    // responding 200: if a recompute throws, we still want Helius to retry
    // the batch (consistent with the batch-failure handling above), rather
    // than reporting success while PnL is left stale.
    for (const walletId of walletIdsWithNewTrades) {
      await pnlTracker.recomputePnl(walletId);
    }

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
