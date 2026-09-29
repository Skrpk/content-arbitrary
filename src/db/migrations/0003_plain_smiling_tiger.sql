CREATE TABLE "workspaces" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text DEFAULT 'default' NOT NULL,
	"telegram_chat_id" text,
	"telegram_admin_chat_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The single tenant that existing rows belong to. It must exist before the
-- foreign keys below are added, or back-filling `workspace_id` on a database
-- that already has posts would violate them.
INSERT INTO "workspaces" ("id", "name") VALUES (1, 'default') ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
-- Explicit id above leaves the sequence behind; move it past what we inserted
-- so the next workspace does not collide.
SELECT setval(pg_get_serial_sequence('workspaces', 'id'), GREATEST((SELECT max("id") FROM "workspaces"), 1));--> statement-breakpoint
DROP INDEX "processed_posts_x_post_id_key";--> statement-breakpoint
DROP INDEX "sources_platform_external_id_key";--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "processed_posts" ADD COLUMN "source_id" integer;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Attribute existing posts to the source they came from, where the author
-- handle still matches one. Rows that predate sources simply stay unattributed.
UPDATE "processed_posts" p
SET "source_id" = s."id"
FROM "sources" s
WHERE p."source_id" IS NULL
  AND s."platform" = 'x'
  AND lower(s."username") = lower(p."x_author_username");--> statement-breakpoint
ALTER TABLE "processed_posts" ADD CONSTRAINT "processed_posts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_posts" ADD CONSTRAINT "processed_posts_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "processed_posts_workspace_x_post_id_key" ON "processed_posts" USING btree ("workspace_id","x_post_id");--> statement-breakpoint
CREATE INDEX "processed_posts_source_idx" ON "processed_posts" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_workspace_platform_external_id_key" ON "sources" USING btree ("workspace_id","platform","external_id");
