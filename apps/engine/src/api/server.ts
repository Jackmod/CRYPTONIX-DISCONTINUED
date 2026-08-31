import express, { type Express } from 'express';
import { eq } from 'drizzle-orm';
import type { Db } from '@cryptonix/db';
import { wallets, walletTrades, pnlDaily } from '@cryptonix/db';
import type { HeliusEnhancedTransaction } from '@cryptonix/core';
import type { WalletMonitor } from '../monitors/wallet-monitor.js';
import type { PnlTracker } from '../monitors/pnl-tracker.js';
import type { AlertBus } from './alert-bus.js';

export function createServer(db: Db, walletMonitor: WalletMonitor, pnlTracker: PnlTracker, _alertBus: AlertBus): Express {
  const app = express();
  app.use(express.json());

  app.get('/wallets', async (_req, res) => {
    res.json(await db.select().from(wallets));
  });

  app.post('/wallets', async (req, res) => {
    const { address, label, isMine } = req.body as { address?: string; label?: string; isMine?: boolean };
    if (!address || !label) {
      res.status(400).json({ error: 'address and label are required' });
      return;
    }
    const wallet = await walletMonitor.trackWallet(address, label, Boolean(isMine));
    res.status(201).json(wallet);

    pnlTracker.backfillWallet(wallet.id, wallet.address).catch((err) => {
      console.error(`pnl backfill failed for wallet ${wallet.id}`, err);
    });
  });

  app.get('/wallets/:id/trades', async (req, res) => {
    const walletId = Number(req.params.id);
    res.json(await db.select().from(walletTrades).where(eq(walletTrades.walletId, walletId)).orderBy(walletTrades.ts));
  });

  app.get('/wallets/:id/pnl', async (req, res) => {
    const walletId = Number(req.params.id);
    res.json(await db.select().from(pnlDaily).where(eq(pnlDaily.walletId, walletId)));
  });

  app.post('/webhooks/helius', async (req, res) => {
    const body = req.body as HeliusEnhancedTransaction | HeliusEnhancedTransaction[];
    await walletMonitor.handleWebhookPayload(Array.isArray(body) ? body : [body]);
    res.status(200).send();
  });

  return app;
}
