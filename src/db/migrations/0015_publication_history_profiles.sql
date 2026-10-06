CREATE TABLE "publication_history_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"profile" jsonb NOT NULL,
	"source_item_count" integer NOT NULL,
	"source_fingerprint" text NOT NULL,
	"history_cutoff_at" timestamp with time zone NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "radar_evaluations" ADD COLUMN "publication_history_profile_id" integer;--> statement-breakpoint
ALTER TABLE "publication_history_profiles" ADD CONSTRAINT "publication_history_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publication_history_profiles_workspace_idx" ON "publication_history_profiles" USING btree ("workspace_id","history_cutoff_at");--> statement-breakpoint
CREATE INDEX "publication_history_profiles_fingerprint_idx" ON "publication_history_profiles" USING btree ("workspace_id","source_fingerprint");--> statement-breakpoint
ALTER TABLE "radar_evaluations" ADD CONSTRAINT "radar_evaluations_history_profile_id_fk" FOREIGN KEY ("publication_history_profile_id") REFERENCES "public"."publication_history_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "radar_evaluations_history_profile_idx" ON "radar_evaluations" USING btree ("publication_history_profile_id");