ALTER TABLE "processed_posts" ADD COLUMN "review_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "review_digest_minutes" integer DEFAULT 60;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "review_digest_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "review_digest_covered_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "review_digest_message_id" bigint;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_review_digest_minutes_check" CHECK ("workspaces"."review_digest_minutes" IS NULL OR "workspaces"."review_digest_minutes" BETWEEN 15 AND 129600);