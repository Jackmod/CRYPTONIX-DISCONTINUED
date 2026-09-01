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

export const discordGuilds = pgTable('discord_guilds', {
  guildId: text('guild_id').primaryKey(),
  alertChannelId: text('alert_channel_id').notNull(),
  setupBy: text('setup_by'),
  setupAt: timestamp('setup_at').notNull().defaultNow(),
});

/**
 * Small key/value store for consumer state the engine holds on a client's
 * behalf.
 *
 * The Discord bot keeps its alert-replay cursor here. Held only in memory, it
 * reset to the engine's head on every start, so alerts published while the bot
 * process was down were never replayed — the one case the replay mechanism
 * most obviously exists for.
 */
export const clientState = pgTable('client_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

/**
 * Coins the scanner has already considered, so it never alerts the same mint
 * twice.
 *
 * Keyed by mint rather than by an id: the scanner polls the same discovery
 * feed every minute and sees the same coins repeatedly, and an in-memory set
 * would forget everything on restart and re-alert the lot.
 *
 * Coins that did NOT pass are recorded too, with `alerted` false — otherwise
 * every poll re-scores the same rejects forever, and a coin that later crosses
 * the threshold could still be alerted once by flipping that flag.
 */
export const scannedCoins = pgTable('scanned_coins', {
  mint: text('mint').primaryKey(),
  symbol: text('symbol').notNull(),
  alerted: boolean('alerted').notNull().default(false),
  momentumScore: integer('momentum_score'),
  /** The token's real logo (spec §5.3), or null when the provider has none. */
  imageUrl: text('image_url'),
  /** The snapshot the score was computed from, so the UI can show the numbers. */
  stats: jsonb('stats'),
  firstSeenAt: timestamp('first_seen_at').notNull().defaultNow(),
  lastCheckedAt: timestamp('last_checked_at').notNull().defaultNow(),
});

/**
 * X accounts the user asked to follow.
 *
 * The handle is the key rather than an X user id, because a person types a
 * handle and that is what the discovery API is asked for. Stored lowercased
 * and without the '@' (see normalizeHandle in @cryptonix/core), so 'Ansem',
 * '@ansem' and 'x.com/ansem' cannot become three rows polling one account and
 * posting every tweet three times.
 *
 * `lastTweetId` is the watermark: tweets at or below it have already been
 * seen. It is a text column because a tweet id is a 64-bit snowflake, and
 * storing it as a number would silently corrupt the last digits.
 */
export const trackedHandles = pgTable('tracked_handles', {
  id: serial('id').primaryKey(),
  handle: text('handle').notNull().unique(),
  lastTweetId: text('last_tweet_id'),
  addedAt: timestamp('added_at').notNull().defaultNow(),
});

/**
 * Tweets already seen, so the same one is never alerted twice.
 *
 * Keyed by the tweet id for the same reason scanned_coins is keyed by mint: a
 * poll returns the same recent tweets over and over, and an in-memory set
 * would forget them on restart and re-post the lot.
 *
 * `alerted` records whether a stored tweet was ever announced. It is NOT what
 * stops a burst when a handle is first followed — the monitor decides that,
 * and the primary key above is what stops a re-poll re-announcing anything.
 * What this is for is telling those two apart afterwards: a row left false is
 * one the monitor stored and then failed to publish, which is the fingerprint
 * of a crash between the two writes and is otherwise invisible.
 */
export const tweets = pgTable('tweets', {
  id: text('id').primaryKey(),
  handle: text('handle').notNull(),
  authorName: text('author_name').notNull(),
  authorAvatarUrl: text('author_avatar_url'),
  text: text('text').notNull(),
  media: jsonb('media').notNull().default([]),
  url: text('url').notNull(),
  likeCount: integer('like_count'),
  replyCount: integer('reply_count'),
  alerted: boolean('alerted').notNull().default(false),
  postedAt: timestamp('posted_at').notNull(),
  seenAt: timestamp('seen_at').notNull().defaultNow(),
});
