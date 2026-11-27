CREATE TABLE "onboarding_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"telegram_user_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"workspace_id" integer,
	"channel_username" text,
	"channel_chat_id" text,
	"channel_title" text,
	"status" text DEFAULT 'awaiting_channel' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status_message_id" bigint,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "onboarding_sessions_status_check" CHECK ("onboarding_sessions"."status" IN ('awaiting_channel', 'analyzing_history', 'profiling', 'discovering_sources', 'activating_sources', 'active', 'failed')),
	CONSTRAINT "onboarding_sessions_language_check" CHECK ("onboarding_sessions"."language" IN ('uk', 'en'))
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "editorial_profile_source" text;--> statement-breakpoint
ALTER TABLE "onboarding_sessions" ADD CONSTRAINT "onboarding_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_sessions" ADD CONSTRAINT "onboarding_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_sessions_one_open_key" ON "onboarding_sessions" USING btree ("telegram_user_id") WHERE "onboarding_sessions"."status" NOT IN ('active', 'failed');--> statement-breakpoint
CREATE INDEX "onboarding_sessions_runnable_idx" ON "onboarding_sessions" USING btree ("status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_editorial_profile_source_check" CHECK ("workspaces"."editorial_profile_source" IS NULL OR "workspaces"."editorial_profile_source" IN ('auto', 'editor'));