CREATE TYPE "public"."source_platform" AS ENUM('x');--> statement-breakpoint
CREATE TABLE "sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" "source_platform" DEFAULT 'x' NOT NULL,
	"external_id" text NOT NULL,
	"username" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sources_platform_external_id_key" ON "sources" USING btree ("platform","external_id");--> statement-breakpoint
CREATE INDEX "sources_enabled_idx" ON "sources" USING btree ("enabled");