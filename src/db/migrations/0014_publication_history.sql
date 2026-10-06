CREATE TABLE "publication_history_imports" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"adapter" text NOT NULL,
	"platform" text,
	"publication_key" text,
	"original_filename" text NOT NULL,
	"file_sha256" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"items_seen" integer DEFAULT 0 NOT NULL,
	"items_imported" integer DEFAULT 0 NOT NULL,
	"items_updated" integer DEFAULT 0 NOT NULL,
	"items_unchanged" integer DEFAULT 0 NOT NULL,
	"items_skipped" integer DEFAULT 0 NOT NULL,
	"items_failed" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"error_message" text,
	"metadata" jsonb,
	CONSTRAINT "publication_history_imports_status_check" CHECK ("publication_history_imports"."status" IN ('processing', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "publication_history_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"platform" text NOT NULL,
	"publication_key" text NOT NULL,
	"external_id" text NOT NULL,
	"content_type" text NOT NULL,
	"title" text,
	"text" text,
	"published_at" timestamp with time zone NOT NULL,
	"edited_at" timestamp with time zone,
	"canonical_url" text,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metrics" jsonb,
	"metadata" jsonb,
	"import_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_history_items_content_type_check" CHECK ("publication_history_items"."content_type" IN ('post', 'newsletter_issue', 'article', 'video', 'podcast_episode', 'other'))
);
--> statement-breakpoint
ALTER TABLE "publication_history_imports" ADD CONSTRAINT "publication_history_imports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_history_items" ADD CONSTRAINT "publication_history_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_history_items" ADD CONSTRAINT "publication_history_items_import_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."publication_history_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publication_history_imports_workspace_idx" ON "publication_history_imports" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "publication_history_items_identity_key" ON "publication_history_items" USING btree ("workspace_id","platform","publication_key","external_id");