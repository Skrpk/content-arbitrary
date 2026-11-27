CREATE TABLE "source_suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer,
	"workspace_id" integer NOT NULL,
	"platform" "source_platform" NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text NOT NULL,
	"target" text NOT NULL,
	"origin" text NOT NULL,
	"links" integer DEFAULT 0 NOT NULL,
	"forwards" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"kind" text,
	"organization" text,
	"via" text,
	"score" integer DEFAULT 0 NOT NULL,
	"rank" integer NOT NULL,
	"state" text NOT NULL,
	"activated_source_id" integer,
	"activation_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_suggestions_origin_check" CHECK ("source_suggestions"."origin" IN ('history_link', 'history_forward', 'discovery', 'manual')),
	CONSTRAINT "source_suggestions_state_check" CHECK ("source_suggestions"."state" IN ('picked', 'active', 'reserve', 'removed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "source_suggestions" ADD CONSTRAINT "source_suggestions_session_id_onboarding_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."onboarding_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_suggestions" ADD CONSTRAINT "source_suggestions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_suggestions" ADD CONSTRAINT "source_suggestions_activated_source_id_sources_id_fk" FOREIGN KEY ("activated_source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_suggestions_workspace_idx" ON "source_suggestions" USING btree ("workspace_id","state","rank");