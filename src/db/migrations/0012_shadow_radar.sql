CREATE TABLE "radar_evaluations" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"processed_post_id" integer NOT NULL,
	"mode" text NOT NULL,
	"variant" text NOT NULL,
	"status" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"score" integer,
	"predicted_decision" text,
	"topic_fit" integer,
	"editorial_fit" integer,
	"importance" integer,
	"reason" text,
	"predicted_rejection_reason" "rejection_reason",
	"image_included" boolean DEFAULT false NOT NULL,
	"example_post_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "radar_evaluations_mode_check" CHECK ("radar_evaluations"."mode" IN ('live', 'backfill')),
	CONSTRAINT "radar_evaluations_variant_check" CHECK ("radar_evaluations"."variant" IN ('text', 'text_image')),
	CONSTRAINT "radar_evaluations_status_check" CHECK ("radar_evaluations"."status" IN ('ok', 'failed', 'skipped')),
	CONSTRAINT "radar_evaluations_prediction_check" CHECK ("radar_evaluations"."status" <> 'ok' OR ("radar_evaluations"."score" BETWEEN 0 AND 100 AND "radar_evaluations"."predicted_decision" IN ('approve', 'reject')))
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "editorial_profile" text;--> statement-breakpoint
ALTER TABLE "radar_evaluations" ADD CONSTRAINT "radar_evaluations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "radar_evaluations" ADD CONSTRAINT "radar_evaluations_processed_post_id_processed_posts_id_fk" FOREIGN KEY ("processed_post_id") REFERENCES "public"."processed_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "radar_evaluations_post_setup_key" ON "radar_evaluations" USING btree ("processed_post_id","mode","variant","model","prompt_version");--> statement-breakpoint
CREATE INDEX "radar_evaluations_workspace_idx" ON "radar_evaluations" USING btree ("workspace_id");