import { z } from 'zod';
import { YouTubeApiError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import type { YouTubeChannelRef } from '@/lib/youtube/channel';

/**
 * The YouTube Data API, as little of it as a channel source needs: finding a
 * channel (channels.list), its newest uploads (playlistItems.list) and their
 * details (videos.list), each one quota unit a call. Never search.list, which
 * costs a hundred.
 *
 * Server-side only, with YOUTUBE_API_KEY; every call is logged with its quota
 * cost, to be added up later. What comes back is checked before it is used.
 */

const API_BASE_URL = 'https://www.googleapis.com/youtube/v3';
const TIMEOUT_MS = 12_000;
/** Videos one videos.list call may ask for. */
export const VIDEOS_PER_CALL = 50;

export interface YouTubeChannel {
  id: string;
  title: string;
  /** `@pbsspacetime`, when the channel has a handle. */
  handle: string | null;
  uploadsPlaylistId: string | null;
}

export interface YouTubeUpload {
  videoId: string;
  /** When the video was published; null for one not out yet — a premiere still to come. */
  publishedAt: Date | null;
}

export interface YouTubeVideo {
  id: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: Date;
  liveBroadcastContent: 'none' | 'live' | 'upcoming';
  durationSeconds: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  thumbnailUrl: string | null;
}

const errorSchema = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional() }).passthrough()).optional(),
  }),
});

const channelsSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        snippet: z.object({ title: z.string(), customUrl: z.string().optional() }).passthrough(),
        contentDetails: z
          .object({ relatedPlaylists: z.object({ uploads: z.string().optional() }).passthrough() })
          .passthrough()
          .optional(),
      }),
    )
    .optional(),
});

const playlistItemsSchema = z.object({
  items: z.array(
    z.object({
      contentDetails: z.object({ videoId: z.string(), videoPublishedAt: z.string().optional() }).passthrough(),
    }),
  ),
  nextPageToken: z.string().optional(),
});

const count = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .optional();

const thumbnail = z.object({ url: z.string() }).passthrough().optional();

const videosSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      snippet: z
        .object({
          title: z.string(),
          description: z.string().default(''),
          channelId: z.string(),
          channelTitle: z.string(),
          publishedAt: z.string(),
          liveBroadcastContent: z.enum(['none', 'live', 'upcoming']).catch('none'),
          thumbnails: z
            .object({ maxres: thumbnail, standard: thumbnail, high: thumbnail, medium: thumbnail, default: thumbnail })
            .passthrough()
            .optional(),
        })
        .passthrough(),
      contentDetails: z.object({ duration: z.string().optional() }).passthrough().optional(),
      statistics: z
        .object({ viewCount: count, likeCount: count, commentCount: count })
        .passthrough()
        .optional(),
    }),
  ),
});

export class YouTubeClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly logger?: Logger;

  constructor(options: { apiKey: string; fetchImpl?: typeof fetch; baseUrl?: string; logger?: Logger }) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.baseUrl ?? API_BASE_URL).replace(/\/+$/, '');
    this.logger = options.logger;
  }

  /** A channel by handle or id, with its uploads playlist; null when there is none such. */
  async getChannel(ref: YouTubeChannelRef): Promise<YouTubeChannel | null> {
    const body = channelsSchema.parse(
      await this.call('channels', {
        part: 'snippet,contentDetails',
        ...(ref.kind === 'handle' ? { forHandle: `@${ref.handle}` } : { id: ref.id }),
        maxResults: '1',
      }),
    );
    const item = body.items?.[0];
    if (!item) return null;
    const custom = item.snippet.customUrl;
    return {
      id: item.id,
      title: item.snippet.title,
      handle: custom ? (custom.startsWith('@') ? custom : `@${custom}`) : null,
      uploadsPlaylistId: item.contentDetails?.relatedPlaylists.uploads ?? null,
    };
  }

  /** A page of a playlist's videos, newest first, as an uploads playlist lists them. */
  async listUploads(
    playlistId: string,
    options: { maxResults: number; pageToken?: string },
  ): Promise<{ uploads: YouTubeUpload[]; nextPageToken: string | null }> {
    const body = playlistItemsSchema.parse(
      await this.call('playlistItems', {
        part: 'contentDetails',
        playlistId,
        maxResults: String(options.maxResults),
        ...(options.pageToken ? { pageToken: options.pageToken } : {}),
      }),
    );
    return {
      uploads: body.items.map((item) => ({
        videoId: item.contentDetails.videoId,
        publishedAt: item.contentDetails.videoPublishedAt ? new Date(item.contentDetails.videoPublishedAt) : null,
      })),
      nextPageToken: body.nextPageToken ?? null,
    };
  }

  /** Videos' details, as many per call as the API takes; a video gone since is absent. */
  async getVideos(ids: string[]): Promise<YouTubeVideo[]> {
    const videos: YouTubeVideo[] = [];
    for (let start = 0; start < ids.length; start += VIDEOS_PER_CALL) {
      const body = videosSchema.parse(
        await this.call('videos', {
          part: 'snippet,contentDetails,statistics',
          id: ids.slice(start, start + VIDEOS_PER_CALL).join(','),
          maxResults: String(VIDEOS_PER_CALL),
        }),
      );
      for (const item of body.items) {
        const thumbs = item.snippet.thumbnails;
        videos.push({
          id: item.id,
          title: item.snippet.title,
          description: item.snippet.description,
          channelId: item.snippet.channelId,
          channelTitle: item.snippet.channelTitle,
          publishedAt: new Date(item.snippet.publishedAt),
          liveBroadcastContent: item.snippet.liveBroadcastContent,
          durationSeconds: parseIsoDuration(item.contentDetails?.duration),
          views: item.statistics?.viewCount ?? null,
          likes: item.statistics?.likeCount ?? null,
          comments: item.statistics?.commentCount ?? null,
          thumbnailUrl: (thumbs?.maxres ?? thumbs?.standard ?? thumbs?.high ?? thumbs?.medium ?? thumbs?.default)?.url ?? null,
        });
      }
    }
    return videos;
  }

  private async call(resource: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/${resource}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('key', this.apiKey);

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
    } catch (error) {
      throw new YouTubeApiError(`Could not reach the YouTube API: ${error instanceof Error ? error.message : String(error)}`, {
        transient: true,
        code: 'youtube_network',
        cause: error,
      });
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    // Every call costs one unit, the failed ones too; the key never reaches a log.
    this.logger?.info('youtube.api_call', {
      resource,
      quotaUnits: 1,
      status: response.status,
      latencyMs: Date.now() - startedAt,
    });

    if (!response.ok) {
      const parsed = errorSchema.safeParse(body);
      const reason = parsed.success ? parsed.data.error.errors?.[0]?.reason : undefined;
      const message = parsed.success ? (parsed.data.error.message ?? `HTTP ${response.status}`) : `HTTP ${response.status}`;
      throw new YouTubeApiError(`YouTube API ${resource}: ${message}`, {
        // Quota and rate limits pass; a bad key or request does not.
        transient: response.status >= 500 || response.status === 429 || reason === 'quotaExceeded' || reason === 'rateLimitExceeded',
        code: reason ? `youtube_${reason}` : `youtube_http_${response.status}`,
        status: response.status,
      });
    }
    return body;
  }
}

/** `PT1H2M3S` → 3723; null for what is not such a duration (a live stream's `P0D` is 0). */
export function parseIsoDuration(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match.map((part) => (part ? Number(part) : 0));
  return days! * 86_400 + hours! * 3_600 + minutes! * 60 + seconds!;
}
