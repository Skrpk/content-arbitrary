CREATE TABLE "media_understandings" (
	"id" serial PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"detail" text NOT NULL,
	"status" text NOT NULL,
	"summary" text,
	"content_type" text,
	"topics" text[] DEFAULT '{}'::text[] NOT NULL,
	"entities" text[] DEFAULT '{}'::text[] NOT NULL,
	"visible_text" text,
	"information_value" text,
	"media_type" text,
	"byte_length" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" double precision,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_understandings_status_check" CHECK ("media_understandings"."status" IN ('ok', 'failed')),
	CONSTRAINT "media_understandings_ok_check" CHECK ("media_understandings"."status" <> 'ok' OR "media_understandings"."summary" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "image_fingerprint" text;--> statement-breakpoint
ALTER TABLE "publication_history_items" ADD COLUMN "image_fingerprint" text;--> statement-breakpoint
ALTER TABLE "radar_evaluations" ADD COLUMN "media_understanding_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "media_understandings_identity_key" ON "media_understandings" USING btree ("fingerprint","model","prompt_version","detail");--> statement-breakpoint
ALTER TABLE "radar_evaluations" ADD CONSTRAINT "radar_evaluations_media_understanding_fk" FOREIGN KEY ("media_understanding_id") REFERENCES "public"."media_understandings"("id") ON DELETE set null ON UPDATE no action;