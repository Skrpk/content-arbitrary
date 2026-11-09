import type { Database } from '@/lib/db';
import type { Env } from '@/lib/env';
import type { Logger } from '@/lib/logger';
import { describeError } from '@/lib/errors';
import { refreshChannelMedia } from '@/lib/telegram-channel/refresh-media';
import { threadsPost } from '@/lib/threads/client';
import { threadsReaderFor, threadsReading } from '@/lib/threads/reader';
import { parseThreadsPostId, threadsMediaOf } from '@/lib/threads/source';
import type { NormalizedMedia } from '@/types';

/**
 * A queued post's media at addresses that work now. A Telegram channel's and
 * a Threads post's media links expire, so they are looked up afresh before
 * they are fetched; anything else is returned as it is. Best effort: when
 * the lookup fails, the stored links are tried as they are.
 */
export async function refreshSourceMedia(
  externalId: string,
  media: NormalizedMedia[],
  context: { db: Database; env: Env; workspaceId: number; logger?: Logger; fetchImpl?: typeof fetch },
): Promise<NormalizedMedia[]> {
  const threadsId = parseThreadsPostId(externalId);
  if (!threadsId) return refreshChannelMedia(externalId, media, { fetchImpl: context.fetchImpl });
  if (media.length === 0) return media;

  try {
    const reading = threadsReading(context.env);
    const reader = reading ? await threadsReaderFor(context.db, reading, context.workspaceId) : null;
    if (!reader) return media;
    const fresh = threadsMediaOf(await threadsPost(reader.token, threadsId, { fetchImpl: context.fetchImpl }));
    // Only when it still has what it had, in the same order: anything else, and the stored links stand.
    if (fresh.length !== media.length || fresh.some((item, index) => item.kind !== media[index]!.kind)) return media;
    return media.map((item, index) => ({ ...item, url: fresh[index]!.url, ...(fresh[index]!.previewUrl ? { previewUrl: fresh[index]!.previewUrl } : {}) }));
  } catch (error) {
    context.logger?.warn('threads.media_refresh_failed', { externalId, error: describeError(error) });
    return media;
  }
}
