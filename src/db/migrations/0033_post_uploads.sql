CREATE TABLE "post_uploads" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"processed_post_id" integer NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"pathname" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "post_uploads_kind_check" CHECK ("post_uploads"."kind" IN ('photo', 'video'))
);
--> statement-breakpoint
ALTER TABLE "post_uploads" ADD CONSTRAINT "post_uploads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_uploads" ADD CONSTRAINT "post_uploads_processed_post_id_processed_posts_id_fk" FOREIGN KEY ("processed_post_id") REFERENCES "public"."processed_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "post_uploads_url_key" ON "post_uploads" USING btree ("url");--> statement-breakpoint
CREATE INDEX "post_uploads_post_idx" ON "post_uploads" USING btree ("processed_post_id");