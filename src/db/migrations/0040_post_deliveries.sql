CREATE TABLE "post_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"processed_post_id" integer NOT NULL,
	"workspace_id" integer NOT NULL,
	"platform" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"content" jsonb NOT NULL,
	"container_id" text,
	"hosted_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"external_id" text,
	"url" text,
	"error" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "publish_targets" text[];--> statement-breakpoint
ALTER TABLE "post_deliveries" ADD CONSTRAINT "post_deliveries_processed_post_id_processed_posts_id_fk" FOREIGN KEY ("processed_post_id") REFERENCES "public"."processed_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_deliveries" ADD CONSTRAINT "post_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "post_deliveries_post_platform_key" ON "post_deliveries" USING btree ("processed_post_id","platform");--> statement-breakpoint
CREATE INDEX "post_deliveries_status_idx" ON "post_deliveries" USING btree ("status","next_attempt_at");