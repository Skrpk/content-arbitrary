ALTER TABLE "processed_posts" ADD COLUMN "review_media" jsonb;--> statement-breakpoint
-- Posts still awaiting a decision, or scheduled, hold their Telegram file ids
-- only in approval_payload, which is dropped once they are decided. Copy them
-- now so their pictures outlive the decision too. Posts already decided have
-- no payload left and stay null.
UPDATE "processed_posts"
SET "review_media" = (
  SELECT jsonb_agg(jsonb_build_object('kind', item->>'kind', 'fileId', item->>'fileId') ORDER BY position)
  FROM jsonb_array_elements("approval_payload"->'items') WITH ORDINALITY AS items(item, position)
)
WHERE "review_media" IS NULL
  AND "approval_payload" IS NOT NULL
  AND jsonb_array_length("approval_payload"->'items') > 0;
