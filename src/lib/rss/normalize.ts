import { truncateForDisplay } from '@/lib/telegram/format-caption';
import { rssItemId } from '@/lib/rss/identity';
import { htmlToText } from '@/lib/rss/text';
import type { ParsedFeedEntry } from '@/lib/rss/types';
import type { NormalizedPost } from '@/types';

/**
 * A feed entry as a candidate post, in the shape the rest of the pipeline —
 * Radar, translation, review, publishing — already takes from X.
 *
 * Only what the feed itself says: its title and summary (or content). The
 * article is never fetched, and the entry carries no media — RSS candidates
 * are text posts, with the article's link kept alongside, not in the text.
 */

/** Most text a feed entry brings in: a summary, not a 100 KB article body. */
export const RSS_TEXT_MAX = 6000;

/** A summary shorter than this says too little; the content is used instead. */
const MEANINGFUL_SUMMARY = 40;

/** Title, then the summary — or the content when the summary says too little — as plain text. */
export function entryText(entry: Pick<ParsedFeedEntry, 'title' | 'summary' | 'content'>): string {
  const title = entry.title?.trim() ?? '';
  const summary = htmlToText(entry.summary ?? '');
  const content = htmlToText(entry.content ?? '');
  let body = summary.length >= MEANINGFUL_SUMMARY || !content ? summary : content;

  // Many feeds open the description with the title again, as a sentence or
  // line of its own; say it once. Not when the title just begins a sentence.
  if (title && body.toLowerCase().startsWith(title.toLowerCase())) {
    const rest = body.slice(title.length);
    if (rest === '' || /^[.!?:]?\s*\n|^[.!?:]\s/.test(rest)) body = rest.replace(/^[.!?:]?\s*/, '');
  }

  const text = [title, body].filter((part) => part !== '').join('\n\n');
  return truncateForDisplay(text, RSS_TEXT_MAX);
}

export function entryToPost(
  entry: ParsedFeedEntry,
  feed: { feedUrl: string; displayName: string },
): NormalizedPost {
  return {
    platform: 'rss',
    id: rssItemId(feed.feedUrl, entry.stableId),
    // Empty when the entry has no link: one is never invented, nor the feed's used.
    url: entry.url ?? '',
    // The feed's name rather than the article's author: it is the source the
    // reviewer and Radar know, and what `x_author_username` names for X too.
    authorUsername: feed.displayName,
    createdAt: entry.publishedAt ?? entry.updatedAt,
    text: entryText(entry),
    media: [],
    isReply: false,
    isRepost: false,
    isQuote: false,
    metrics: null,
  };
}

/**
 * Oldest first, so the channel reads in order. Entries without a date keep
 * the feed's own order, reversed — feeds list newest first.
 */
export function oldestFirst(posts: NormalizedPost[]): NormalizedPost[] {
  return posts
    .map((post, index) => ({ post, index }))
    .sort((a, b) => {
      const at = a.post.createdAt?.getTime();
      const bt = b.post.createdAt?.getTime();
      if (at !== undefined && bt !== undefined && at !== bt) return at - bt;
      return b.index - a.index;
    })
    .map(({ post }) => post);
}
