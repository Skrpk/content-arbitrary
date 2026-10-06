-- pgvector, for the embedding columns below. Neon ships it; on a self-hosted
-- Postgres the extension has to be installed first (e.g. the pgvector/pgvector image).
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "publication_history_embeddings" (
	"id" serial PRIMARY KEY NOT NULL,
	"publication_history_item_id" integer NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"content_fingerprint" text NOT NULL,
	"embedding" vector NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_history_embeddings_dimensions_check" CHECK (vector_dims("publication_history_embeddings"."embedding") = "publication_history_embeddings"."dimensions")
);
--> statement-breakpoint
CREATE TABLE "radar_candidate_embeddings" (
	"id" serial PRIMARY KEY NOT NULL,
	"processed_post_id" integer NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"content_fingerprint" text NOT NULL,
	"embedding" vector NOT NULL,
	"input_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "radar_candidate_embeddings_dimensions_check" CHECK (vector_dims("radar_candidate_embeddings"."embedding") = "radar_candidate_embeddings"."dimensions")
);
--> statement-breakpoint
ALTER TABLE "radar_evaluations" ADD COLUMN "history_retrieval" jsonb;--> statement-breakpoint
ALTER TABLE "radar_evaluations" ADD COLUMN "historical_assessment" jsonb;--> statement-breakpoint
ALTER TABLE "publication_history_embeddings" ADD CONSTRAINT "publication_history_embeddings_item_id_fk" FOREIGN KEY ("publication_history_item_id") REFERENCES "public"."publication_history_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "radar_candidate_embeddings" ADD CONSTRAINT "radar_candidate_embeddings_post_id_fk" FOREIGN KEY ("processed_post_id") REFERENCES "public"."processed_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "publication_history_embeddings_item_model_key" ON "publication_history_embeddings" USING btree ("publication_history_item_id","model");--> statement-breakpoint
CREATE UNIQUE INDEX "radar_candidate_embeddings_post_model_key" ON "radar_candidate_embeddings" USING btree ("processed_post_id","model");