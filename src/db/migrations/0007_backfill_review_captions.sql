-- Give every post that still holds a review payload its two captions.
--
-- The payload is the only place a caption was ever stored, so it is the only
-- source: for a post that was never edited it is the original and the current
-- text at once. For one that was edited, the original was overwritten before
-- this column existed and cannot be recovered — it gets the edited text in
-- both columns, and keeps its edit time, so that "edited, yet original equals
-- current" marks exactly those rows.
--
-- Published and rejected rows dropped their payload when they were decided,
-- so their captions are gone and they stay null. Idempotent: only rows with no
-- original yet are touched.
UPDATE "processed_posts"
SET
  "original_caption" = "approval_payload"->>'caption',
  "caption" = "approval_payload"->>'caption',
  "caption_edited_at" = ("approval_payload"->>'captionEditedAt')::timestamptz
WHERE "original_caption" IS NULL
  AND "approval_payload"->>'caption' IS NOT NULL;
