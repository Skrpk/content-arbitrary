ALTER TYPE "public"."post_status" ADD VALUE 'awaiting_approval';--> statement-breakpoint
ALTER TYPE "public"."post_status" ADD VALUE 'rejected';--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "approval_payload" jsonb;--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "admin_chat_id" text;--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "admin_message_id" bigint;--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "reviewed_at" timestamp with time zone;