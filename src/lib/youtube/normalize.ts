import type { SourceMetadata } from '@/db/schema';
import { YOUTUBE_VIDEO_ID_PREFIX } from '@/lib/sources/display';
import { truncateToLength } from '@/lib/telegram/format-caption';
import { watchUrl } from '@/lib/youtube/channel';
import type { YouTubeVideo } from '@/lib/youtube/client';
import type { TranscriptResult } from '@/lib/youtube/transcript';
import type { NormalizedPost } from '@/types';

/**
 * A YouTube video as a candidate like any other.
 *
 * Its text — what is translated, reviewed and published — is the title and
 * the opening of the description: what the video is, in a post's length. Its
 * transcript, when it has one, is `analysisText`, for Radar and the embedding
 * only. It has no media: the video is never downloaded, and the post goes out
 * with its link, which Telegram previews with YouTube's own player.
 *
 * Its id is `yt:<video id>`, apart from X's digits, `rss:` and `tg:`.
 */

/** Of the description, what a post carries: its opening, not the sponsor reads and link lists below. */
const DESCRIPTION_MAX = 700;

/** `transcript` is null when no provider is set up; `provider` names the one that answered. */
export function videoToPost(video: YouTubeVideo, transcript: TranscriptResult | null, provider: string | null = null): NormalizedPost {
  const description = openingOf(video.description);
  return {
    platform: 'youtube',
    id: `${YOUTUBE_VIDEO_ID_PREFIX}${video.id}`,
    url: watchUrl(video.id),
    authorUsername: video.channelTitle,
    createdAt: video.publishedAt,
    text: [video.title.trim(), description].filter((part) => part !== '').join('\n\n'),
    media: [],
    analysisText: transcript?.status === 'available' ? transcript.text : null,
    sourceMetadata: metadataOf(video, transcript, provider),
    isReply: false,
    isRepost: false,
    isQuote: false,
    metrics: null,
  };
}

function metadataOf(video: YouTubeVideo, transcript: TranscriptResult | null, provider: string | null): SourceMetadata {
  return {
    durationSeconds: video.durationSeconds,
    views: video.views,
    likes: video.likes,
    comments: video.comments,
    live: video.liveBroadcastContent,
    transcript: transcript
      ? {
          status: transcript.status,
          language: transcript.status === 'available' ? transcript.language : null,
          length: transcript.status === 'available' ? transcript.text.length : null,
          provider,
        }
      : { status: 'not_configured' },
  };
}

/**
 * The description's opening paragraphs, up to a post's worth: without a
 * paragraph that carries a link — a sponsor read, a merch or Patreon plug,
 * which is what a link in a description almost always is — and without the
 * lines that are only hashtags or timestamps.
 */
export function openingOf(description: string): string {
  const paragraphs = description
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .filter((paragraph) => !/(?:https?:\/\/|www\.)\S+/i.test(paragraph))
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !/^(?:(?:https?:\/\/|www\.)\S+|#\S+(?:\s+#\S+)*|\d{1,2}:\d{2}(?::\d{2})?\b.*)$/i.test(line))
        .join('\n'),
    )
    .filter((paragraph) => paragraph !== '');

  const kept: string[] = [];
  let length = 0;
  for (const paragraph of paragraphs) {
    if (length + paragraph.length > DESCRIPTION_MAX) {
      if (kept.length === 0) kept.push(`${truncateToLength(paragraph, DESCRIPTION_MAX - 1)}…`);
      break;
    }
    kept.push(paragraph);
    length += paragraph.length + 2;
  }
  return kept.join('\n\n');
}

/** "12 min" or "1 h 5 min": a video's length as Radar is told it. */
export function describeDuration(seconds: number | null | undefined): string | null {
  if (!seconds) return null;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
