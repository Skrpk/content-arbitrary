CREATE TYPE "public"."post_status" AS ENUM('pending', 'processing', 'published', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "processed_posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"x_post_id" text NOT NULL,
	"x_post_url" text NOT NULL,
	"x_author_username" text,
	"x_created_at" timestamp with time zone,
	"status" "post_status" DEFAULT 'pending' NOT NULL,
	"telegram_chat_id" text,
	"telegram_message_id" bigint,
	"media_count" integer DEFAULT 0 NOT NULL,
	"telegram_method" text,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"last_seen_post_id" text,
	"last_sync_at" timestamp with time zone,
	"last_successful_sync_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"processed_post_id" integer NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"telegram_chat_id" text NOT NULL,
	"media_index" integer,
	"kind" text DEFAULT 'media' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_processed_post_id_processed_posts_id_fk" FOREIGN KEY ("processed_post_id") REFERENCES "public"."processed_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "processed_posts_x_post_id_key" ON "processed_posts" USING btree ("x_post_id");--> statement-breakpoint
CREATE INDEX "processed_posts_status_idx" ON "processed_posts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "processed_posts_processed_at_idx" ON "processed_posts" USING btree ("processed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_state_source_key" ON "sync_state" USING btree ("source");--> statement-breakpoint
CREATE INDEX "telegram_messages_post_idx" ON "telegram_messages" USING btree ("processed_post_id");