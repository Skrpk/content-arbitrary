ALTER TABLE "workspaces" ADD COLUMN "threads_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Kept on for the tenants that already publish there: those with a Threads account connected (photohunt and vector).
UPDATE "workspaces" SET "threads_enabled" = true WHERE "id" IN (SELECT "workspace_id" FROM "threads_accounts");
