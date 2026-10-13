ALTER TYPE "public"."source_platform" ADD VALUE 'youtube';--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "analysis_text" text;--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "source_metadata" jsonb;