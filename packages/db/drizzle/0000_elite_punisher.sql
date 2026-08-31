CREATE TABLE IF NOT EXISTS "alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"ref_id" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"ts" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pnl_daily" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_id" integer NOT NULL,
	"date" text NOT NULL,
	"realized_pnl_sol" double precision DEFAULT 0 NOT NULL,
	"trade_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_id" integer NOT NULL,
	"signature" text NOT NULL,
	"mint" text NOT NULL,
	"side" text NOT NULL,
	"sol_amount" double precision NOT NULL,
	"token_amount" double precision NOT NULL,
	"ts" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallets" (
	"id" serial PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"label" text NOT NULL,
	"is_mine" boolean DEFAULT false NOT NULL,
	"helius_webhook_id" text,
	"backfill_status" text DEFAULT 'pending' NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_address_unique" UNIQUE("address")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pnl_daily" ADD CONSTRAINT "pnl_daily_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wallet_trades" ADD CONSTRAINT "wallet_trades_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pnl_daily_wallet_date_idx" ON "pnl_daily" USING btree ("wallet_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_trades_wallet_sig_idx" ON "wallet_trades" USING btree ("wallet_id","signature");