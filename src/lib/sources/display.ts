import type { SourcePlatform } from '@/db/schema';

/**
 * Each platform's identity: how its posts' ids are told apart in
 * `processed_posts.external_id`, and how a source of it is named to people —
 * and to Radar.
 *
 * An X account is `@NASA`; a feed is its title, `NASA Breaking News`, never
 * `@NASA Breaking News`; a Telegram channel is its username, `@durov`, as
 * Telegram itself names it. Everything shown about a source goes through here
 * rather than writing `@${username}` itself.
 *
 * One entry per platform, and the type insists on it: a new platform is not
 * done until it is named here and has an adapter in
 * src/lib/sync/source-adapters.ts.
 */

interface PlatformIdentity {
  /**
   * Where its posts' ids start in `processed_posts.external_id`, so a stored
   * post is named correctly where only the post is at hand. X's have none:
   * its ids are digits, which no prefix starts with.
   */
  postIdPrefix: string | null;
  /** A source's name as people see it, from its stored username or title. */
  label: (name: string) => string;
}

const handle = (name: string) => `@${name.replace(/^@/, '')}`;

const PLATFORM_IDENTITY: { readonly [P in SourcePlatform]: PlatformIdentity } = {
  x: { postIdPrefix: null, label: handle },
  // `rss:<feed>:<entry>` — see src/lib/rss/identity.ts.
  rss: { postIdPrefix: 'rss:', label: (name) => name },
  // `tg:<channel>/<message id>` — see src/lib/telegram-channel/normalize.ts.
  telegram: { postIdPrefix: 'tg:', label: handle },
  // `yt:<video id>` — see src/lib/youtube/normalize.ts. A channel is named by its title.
  youtube: { postIdPrefix: 'yt:', label: (name) => name },
  // `web:<sha256 of the page's URL>` — see src/lib/website/url.ts. A site is named by its host.
  website: { postIdPrefix: 'web:', label: (name) => name },
};

/** Where a feed item's id starts in `processed_posts.external_id`. */
export const RSS_ITEM_ID_PREFIX = PLATFORM_IDENTITY.rss.postIdPrefix!;

export function isRssItemId(externalId: string): boolean {
  return externalId.startsWith(RSS_ITEM_ID_PREFIX);
}

/** Where a Telegram channel post's id starts in `processed_posts.external_id`. */
export const TELEGRAM_POST_ID_PREFIX = PLATFORM_IDENTITY.telegram.postIdPrefix!;

export function isTelegramPostId(externalId: string): boolean {
  return externalId.startsWith(TELEGRAM_POST_ID_PREFIX);
}

/** Where a YouTube video's id starts in `processed_posts.external_id`. */
export const YOUTUBE_VIDEO_ID_PREFIX = PLATFORM_IDENTITY.youtube.postIdPrefix!;

export function isYoutubeVideoId(externalId: string): boolean {
  return externalId.startsWith(YOUTUBE_VIDEO_ID_PREFIX);
}

/** Where a website page's id starts in `processed_posts.external_id`. */
export const WEB_ITEM_ID_PREFIX = PLATFORM_IDENTITY.website.postIdPrefix!;

export function isWebItemId(externalId: string): boolean {
  return externalId.startsWith(WEB_ITEM_ID_PREFIX);
}

/** The platforms whose sources Radar names by title rather than by handle. */
export type RadarSourcePlatform = 'rss' | 'youtube' | 'website';

/**
 * How Radar's prompt names a post's source, beyond an X handle: a feed's title
 * as it is, a YouTube channel's title or a website's host marked as one.
 * Undefined for X and Telegram, named by handle, so their prompts read as they
 * always have.
 */
export function radarSourcePlatform(externalId: string): RadarSourcePlatform | undefined {
  if (isRssItemId(externalId)) return 'rss';
  if (isYoutubeVideoId(externalId)) return 'youtube';
  if (isWebItemId(externalId)) return 'website';
  return undefined;
}

/** The same, as the field Radar's prompt types take: absent for X and Telegram. */
export function radarSourceMark(externalId: string): { sourcePlatform?: RadarSourcePlatform } {
  const platform = radarSourcePlatform(externalId);
  return platform ? { sourcePlatform: platform } : {};
}

const PREFIXED = (Object.entries(PLATFORM_IDENTITY) as [SourcePlatform, PlatformIdentity][]).filter(
  ([, identity]) => identity.postIdPrefix !== null,
);
const UNPREFIXED = (Object.keys(PLATFORM_IDENTITY) as SourcePlatform[]).find(
  (platform) => PLATFORM_IDENTITY[platform].postIdPrefix === null,
)!;

/** Which platform a stored post came from, told by its id alone. */
export function platformOfPostId(externalId: string): SourcePlatform {
  return PREFIXED.find(([, identity]) => externalId.startsWith(identity.postIdPrefix!))?.[0] ?? UNPREFIXED;
}

/** A source's name: `@handle` on X, `@username` for a Telegram channel, the title of a feed or a YouTube channel, a website's host. */
export function formatSourceLabel(platform: SourcePlatform, name: string): string {
  return PLATFORM_IDENTITY[platform].label(name);
}

/**
 * The name of the source a stored post came from, or null when it was never
 * recorded. Its `x_author_username` holds an X handle, a channel's username
 * or a feed's title.
 */
export function sourceLabelOfPost(externalId: string, author: string | null): string | null {
  if (!author) return null;
  return formatSourceLabel(platformOfPostId(externalId), author);
}
