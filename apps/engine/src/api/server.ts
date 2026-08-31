import express, { type Express, type Request, type Response } from 'express';
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

export function createServer(
  db: Db,
  walletMonitor: WalletMonitor,
  pnlTracker: PnlTracker,
  _alertBus: AlertBus,
  solanaRpc: Pick<SolanaRpcClient, 'getBalanceSol'>
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
    const body = req.body as HeliusEnhancedTransaction | HeliusEnhancedTransaction[];
    await walletMonitor.handleWebhookPayload(Array.isArray(body) ? body : [body]);
    res.status(200).send();
  }));

  return app;
}
