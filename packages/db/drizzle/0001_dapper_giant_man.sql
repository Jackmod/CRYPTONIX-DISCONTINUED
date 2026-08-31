CREATE TABLE IF NOT EXISTS "discord_guilds" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"alert_channel_id" text NOT NULL,
	"setup_by" text,
	"setup_at" timestamp DEFAULT now() NOT NULL
);
