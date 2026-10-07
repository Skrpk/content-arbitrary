ALTER TABLE "sources" ADD COLUMN "following_since" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Sources already there have followed their accounts since they were added.
UPDATE "sources" SET "following_since" = "created_at";
