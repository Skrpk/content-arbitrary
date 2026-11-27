CREATE TABLE "onboarding_waitlist" (
	"telegram_user_id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"username" text,
	"name" text,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"admitted_at" timestamp with time zone,
	CONSTRAINT "onboarding_waitlist_reason_check" CHECK ("onboarding_waitlist"."reason" IN ('not_listed', 'workspaces_cap', 'runs_cap')),
	CONSTRAINT "onboarding_waitlist_language_check" CHECK ("onboarding_waitlist"."language" IN ('uk', 'en'))
);
--> statement-breakpoint
CREATE TABLE "product_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"user_id" integer,
	"telegram_user_id" text,
	"workspace_id" integer,
	"session_id" integer,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_session_id_onboarding_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."onboarding_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_events_name_idx" ON "product_events" USING btree ("name","occurred_at");--> statement-breakpoint
CREATE INDEX "product_events_workspace_idx" ON "product_events" USING btree ("workspace_id","occurred_at");