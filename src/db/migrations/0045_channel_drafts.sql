CREATE TABLE "channel_drafts" (
	"id" serial PRIMARY KEY NOT NULL,
	"processed_post_id" integer NOT NULL,
	"workspace_id" integer NOT NULL,
	"draft_chat_id" text NOT NULL,
	"message_ids" bigint[] NOT NULL,
	"control_message_id" bigint,
	"status" text DEFAULT 'waiting' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"scheduled_timezone" text,
	"edited_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"published_chat_id" text,
	"published_message_ids" bigint[],
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "draft_chat_id" text;--> statement-breakpoint
ALTER TABLE "channel_drafts" ADD CONSTRAINT "channel_drafts_processed_post_id_processed_posts_id_fk" FOREIGN KEY ("processed_post_id") REFERENCES "public"."processed_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_drafts" ADD CONSTRAINT "channel_drafts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_drafts_post_key" ON "channel_drafts" USING btree ("processed_post_id");--> statement-breakpoint
CREATE INDEX "channel_drafts_status_idx" ON "channel_drafts" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "channel_drafts_chat_idx" ON "channel_drafts" USING btree ("draft_chat_id");