import type { processedPosts } from '@/db/schema';
import { richDocumentPlainText } from '@/lib/rich/document';
import { captionToPlainText, stripFooter, type PostFooter } from '@/lib/telegram/post-footer';

/** The text a post will be published with, as plain text, without the channel's footer. */
export function reviewText(
  row: Pick<typeof processedPosts.$inferSelect, 'caption' | 'approvalPayload' | 'richDoc'>,
  footer: PostFooter | null,
): string {
  if (row.richDoc) return richDocumentPlainText(row.richDoc);
  const stored = row.caption ?? row.approvalPayload?.caption ?? '';
  return captionToPlainText(stripFooter(stored, footer) ?? stored);
}
