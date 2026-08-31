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

    const header = req.header('authorization') ?? '';
    const prefix = 'Bearer ';
    if (!header.startsWith(prefix)) {
      res.status(401).json({ error: 'missing or malformed Authorization header' });
      return;
    }

    const received = Buffer.from(header.slice(prefix.length));
    const expected = Buffer.from(apiKey);
    // Length check first: timingSafeEqual throws on differing lengths.
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      res.status(401).json({ error: 'invalid API key' });
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
  // Helius delivers enhanced transactions in batches; a busy wallet's batch
  // comfortably exceeds express.json()'s 100kb default. Rejecting one with 413
  // would make Helius retry the same oversized batch forever and those trades
  // would never land.
  app.use(express.json({ limit: '2mb' }));
  app.use(requireApiKey(apiKey));

  app.get('/wallets', asyncRoute(async (_req, res) => {
    res.json(await db.select().from(wallets));
  }));

  app.post('/wallets', asyncRoute(async (req, res) => {
    const { address, label, isMine } = (req.body ?? {}) as { address?: string; label?: string; isMine?: boolean };
    if (!address || !label) {
      res.status(400).json({ error: 'address and label are required' });
      return;
    }
    const wallet = await walletMonitor.trackWallet(address, label, Boolean(isMine));
    res.status(201).json(wallet);

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
      const removed = await walletMonitor.untrackWallet(walletId);
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

      const { alertChannelId, setupBy } = (req.body ?? {}) as { alertChannelId?: string; setupBy?: string };
      if (!alertChannelId) {
        res.status(400).json({ error: 'alertChannelId is required' });
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

  return app;
}
