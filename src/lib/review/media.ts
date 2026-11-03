import type { ProcessedPost } from '@/db/schema';
import { shownMediaUrl } from '@/lib/telegram-channel/media-link';

/**
 * The pictures a review page shows for a post: its own media, as the
 * reviewer was shown them — or, for a post with none, the picture of the
 * article it links to, where its source named one (a feed entry's picture, a
 * website page's og:image), standing in for the link preview Telegram will
 * make of it. That picture is only shown, never sent.
 */
export function shownMedia(
  row: Pick<ProcessedPost, 'externalId' | 'reviewMedia' | 'sourceMetadata'>,
): { kind: 'photo' | 'video'; imageUrl: string | null }[] {
  const own = row.reviewMedia ?? [];
  if (own.length > 0) {
    return own.map((item, index) => ({ kind: item.kind, imageUrl: shownMediaUrl(row.externalId, index, item) }));
  }
  const preview = row.sourceMetadata?.previewImageUrl ?? row.sourceMetadata?.website?.imageUrl ?? null;
  return preview ? [{ kind: 'photo', imageUrl: preview }] : [];
}
