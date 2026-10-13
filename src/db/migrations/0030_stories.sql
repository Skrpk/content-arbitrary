CREATE TABLE "stories" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "story_posts" (
	"processed_post_id" integer PRIMARY KEY NOT NULL,
	"story_id" integer NOT NULL,
	"nearest_post_id" integer,
	"similarity" double precision,
	"threshold" double precision NOT NULL,
	"embedding_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_posts" ADD CONSTRAINT "story_posts_processed_post_id_processed_posts_id_fk" FOREIGN KEY ("processed_post_id") REFERENCES "public"."processed_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_posts" ADD CONSTRAINT "story_posts_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_posts" ADD CONSTRAINT "story_posts_nearest_post_id_processed_posts_id_fk" FOREIGN KEY ("nearest_post_id") REFERENCES "public"."processed_posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stories_workspace_idx" ON "stories" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "story_posts_story_idx" ON "story_posts" USING btree ("story_id");