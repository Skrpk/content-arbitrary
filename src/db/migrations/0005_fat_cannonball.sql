-- Scopes each source's cursor to a workspace.
--
-- Existing rows all belong to workspace 1 (seeded in 0003), and the index being
-- dropped already guaranteed `source` unique, so (1, source) cannot collide and
-- the new index builds without conflicts.
DROP INDEX "sync_state_source_key";--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "workspace_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sync_state_workspace_source_key" ON "sync_state" USING btree ("workspace_id","source");