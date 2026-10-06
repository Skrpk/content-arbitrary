ALTER TABLE "processed_posts" ADD COLUMN "x_like_count" integer;--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "x_repost_count" integer;--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "x_reply_count" integer;--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "x_quote_count" integer;--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "x_bookmark_count" integer;--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "x_impression_count" bigint;--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "x_metrics_at" timestamp with time zone;