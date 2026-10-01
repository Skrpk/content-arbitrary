-- Marks a workspace whose legacy X_USER_ID / X_USERNAME pair has been copied
-- into `sources`. NULL means "not imported yet", which is the correct starting
-- value for an existing installation: its env source still has to be imported.
ALTER TABLE "workspaces" ADD COLUMN "legacy_source_imported_at" timestamp with time zone;