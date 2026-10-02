CREATE TYPE "public"."rejection_reason" AS ENUM('not_interesting', 'wrong_topic', 'already_covered', 'too_minor', 'weak_source', 'other');--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "rejection_reason" "rejection_reason";--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "original_caption" text;--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "caption" text;--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "caption_edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "processed_posts" ADD CONSTRAINT "processed_posts_caption_pair_check" CHECK (("processed_posts"."original_caption" IS NULL) = ("processed_posts"."caption" IS NULL));--> statement-breakpoint
ALTER TABLE "processed_posts" ADD CONSTRAINT "processed_posts_rejection_reason_check" CHECK ("processed_posts"."rejection_reason" IS NULL OR "processed_posts"."status" = 'rejected');