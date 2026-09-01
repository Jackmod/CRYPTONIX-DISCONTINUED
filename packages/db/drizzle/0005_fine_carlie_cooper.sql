CREATE TABLE IF NOT EXISTS "tracked_handles" (
	"id" serial PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"last_tweet_id" text,
	"added_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tracked_handles_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tweets" (
	"id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"author_name" text NOT NULL,
	"author_avatar_url" text,
	"text" text NOT NULL,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"url" text NOT NULL,
	"like_count" integer,
	"reply_count" integer,
	"alerted" boolean DEFAULT false NOT NULL,
	"posted_at" timestamp NOT NULL,
	"seen_at" timestamp DEFAULT now() NOT NULL
);
