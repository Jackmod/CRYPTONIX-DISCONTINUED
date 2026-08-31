import { pgTable, serial, text, boolean, timestamp, doublePrecision, integer, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';

export const wallets = pgTable('wallets', {
  id: serial('id').primaryKey(),
  address: text('address').notNull().unique(),
  label: text('label').notNull(),
  isMine: boolean('is_mine').notNull().default(false),
  heliusWebhookId: text('helius_webhook_id'),
  backfillStatus: text('backfill_status').notNull().default('pending'),
  addedAt: timestamp('added_at').notNull().defaultNow(),
});

export const walletTrades = pgTable('wallet_trades', {
  id: serial('id').primaryKey(),
  walletId: integer('wallet_id').notNull().references(() => wallets.id),
  signature: text('signature').notNull(),
  mint: text('mint').notNull(),
  side: text('side').notNull(),
  solAmount: doublePrecision('sol_amount').notNull(),
  tokenAmount: doublePrecision('token_amount').notNull(),
  ts: timestamp('ts').notNull(),
}, (table) => ({
  walletSigIdx: uniqueIndex('wallet_trades_wallet_sig_idx').on(table.walletId, table.signature),
}));

export const pnlDaily = pgTable('pnl_daily', {
  id: serial('id').primaryKey(),
  walletId: integer('wallet_id').notNull().references(() => wallets.id),
  date: text('date').notNull(),
  realizedPnlSol: doublePrecision('realized_pnl_sol').notNull().default(0),
  tradeCount: integer('trade_count').notNull().default(0),
}, (table) => ({
  walletDateIdx: uniqueIndex('pnl_daily_wallet_date_idx').on(table.walletId, table.date),
}));

export const alerts = pgTable('alerts', {
  id: serial('id').primaryKey(),
  type: text('type').notNull(),
  refId: integer('ref_id').notNull(),
  payload: jsonb('payload').notNull(),
  ts: timestamp('ts').notNull().defaultNow(),
});
