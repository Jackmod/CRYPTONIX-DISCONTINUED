import express, { type Express, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '@cryptonix/db';
import { wallets, walletTrades, pnlDaily } from '@cryptonix/db';
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

export function createServer(
  db: Db,
  walletMonitor: WalletMonitor,
  pnlTracker: PnlTracker,
  _alertBus: AlertBus,
  solanaRpc: Pick<SolanaRpcClient, 'getBalanceSol'>,
  webhookSecret: string
): Express {
  const app = express();
  app.use(express.json());

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
