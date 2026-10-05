ALTER TYPE "public"."post_status" ADD VALUE 'scheduled';--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "scheduled_timezone" text;--> statement-breakpoint
CREATE INDEX "processed_posts_scheduled_idx" ON "processed_posts" USING btree ("status","scheduled_for");