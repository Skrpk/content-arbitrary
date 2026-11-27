ALTER TABLE "workspaces" ADD COLUMN "channel_verified_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "created_via" text DEFAULT 'operator' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_via_check" CHECK ("workspaces"."created_via" IN ('operator', 'self_service'));