ALTER TABLE "processed_posts" ADD COLUMN "source_text" text;--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "rejection_note" text;--> statement-breakpoint
ALTER TABLE "processed_posts" ADD CONSTRAINT "processed_posts_rejection_note_check" CHECK ("processed_posts"."rejection_note" IS NULL OR "processed_posts"."rejection_reason" IS NOT NULL);