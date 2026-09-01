CREATE TABLE IF NOT EXISTS "scanned_coins" (
	"mint" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"alerted" boolean DEFAULT false NOT NULL,
	"momentum_score" integer,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_checked_at" timestamp DEFAULT now() NOT NULL
);
