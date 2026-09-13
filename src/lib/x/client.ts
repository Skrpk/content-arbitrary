import { getEnv } from '@/lib/env';
import { XApiError } from '@/lib/errors';
import { withRetry } from '@/lib/sync/retry';
import type { Logger } from '@/lib/logger';
import {
  xTimelineResponseSchema,
  xUserLookupResponseSchema,
  type XTimelineResponse,
  type XUser,
} from '@/lib/x/schemas';

/**
 * Thin client over the X API v2.
 *
 * Endpoints used (verified against https://docs.x.com, 2026-09-13):
 *   GET /2/users/by/username/{username}
 *   GET /2/users/{id}/tweets
 *
 * Cost note: X bills per post read. `since_id` is therefore not just a
 * correctness tool but a billing one — it keeps each run to the handful of
 * posts published since the previous run.
 */

export interface TimelineQuery {
  userId: string;
  maxResults: number;
  sinceId?: string;
  excludeReplies: boolean;
  excludeReposts: boolean;
}

/** Fields we request. Requesting less is cheaper and faster. */
const POST_FIELDS = ['id', 'text', 'created_at', 'attachments', 'entities', 'referenced_tweets', 'author_id'];
const MEDIA_FIELDS = ['media_key', 'type', 'url', 'preview_image_url', 'width', 'height', 'duration_ms', 'variants', 'alt_text'];
const EXPANSIONS = ['attachments.media_keys', 'author_id'];

function parseRetryAfter(response: Response): number | undefined {
  // X returns either Retry-After (seconds) or x-rate-limit-reset (unix seconds).
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }

  const reset = response.headers.get('x-rate-limit-reset');
  if (reset) {
    const resetAt = Number(reset) * 1000;
    if (Number.isFinite(resetAt)) return Math.max(0, resetAt - Date.now());
  }

  return undefined;
}

export class XClient {
  private readonly bearerToken: string;
  private readonly baseUrl: string;
  private readonly logger?: Logger;
  private readonly attempts: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options?: {
    bearerToken?: string;
    baseUrl?: string;
    logger?: Logger;
    attempts?: number;
    fetchImpl?: typeof fetch;
  }) {
    const env = options?.bearerToken && options?.baseUrl ? null : getEnv();
    this.bearerToken = options?.bearerToken ?? env!.X_BEARER_TOKEN;
    this.baseUrl = (options?.baseUrl ?? env!.X_API_BASE_URL).replace(/\/+$/, '');
    this.logger = options?.logger;
    this.attempts = options?.attempts ?? 3;
    this.fetchImpl = options?.fetchImpl ?? fetch;
  }

  private async request(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    return withRetry(
      async () => {
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${this.bearerToken}`,
            'user-agent': 'content-arbitrary/1.0',
          },
          // Never serve a cached timeline: a stale response means missed posts.
          cache: 'no-store',
        });

        if (response.ok) return (await response.json()) as unknown;

        const body = await response.text().catch(() => '');

        if (response.status === 429) {
          throw new XApiError('X API rate limit exceeded', {
            transient: true,
            code: 'x_rate_limited',
            status: 429,
            retryAfterMs: parseRetryAfter(response),
          });
        }

        if (response.status >= 500) {
          throw new XApiError(`X API server error (${response.status})`, {
            transient: true,
            code: 'x_server_error',
            status: response.status,
          });
        }

        // 401/403/404 are configuration problems: a wrong token, a suspended or
        // protected account, or a bad user id. Retrying cannot fix any of them.
        throw new XApiError(
          `X API request failed (${response.status}): ${body.slice(0, 400)}`,
          { transient: false, code: `x_http_${response.status}`, status: response.status },
        );
      },
      { attempts: this.attempts, logger: this.logger, label: `x:${path}` },
    );
  }

  /** Resolve a handle to a numeric user id. Costs one request; cache the id in env. */
  async getUserByUsername(username: string): Promise<XUser> {
    const handle = username.replace(/^@/, '');
    const raw = await this.request(`/2/users/by/username/${encodeURIComponent(handle)}`, {
      'user.fields': 'id,username,name',
    });

    const parsed = xUserLookupResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new XApiError(`Unexpected X user lookup response: ${parsed.error.message}`, {
        transient: false,
        code: 'x_schema_mismatch',
      });
    }

    if (!parsed.data.data) {
      const detail = parsed.data.errors?.[0]?.detail ?? 'user not found';
      throw new XApiError(`Could not resolve @${handle}: ${detail}`, {
        transient: false,
        code: 'x_user_not_found',
      });
    }

    return parsed.data.data;
  }

  async getUserTimeline(query: TimelineQuery): Promise<XTimelineResponse> {
    const params: Record<string, string> = {
      max_results: String(query.maxResults),
      'tweet.fields': POST_FIELDS.join(','),
      'media.fields': MEDIA_FIELDS.join(','),
      expansions: EXPANSIONS.join(','),
    };

    // Let X do the filtering where it can — fewer posts returned is less to pay
    // for and less to sift through locally.
    const exclude: string[] = [];
    if (query.excludeReplies) exclude.push('replies');
    if (query.excludeReposts) exclude.push('retweets');
    if (exclude.length > 0) params.exclude = exclude.join(',');

    if (query.sinceId) params.since_id = query.sinceId;

    const raw = await this.request(`/2/users/${encodeURIComponent(query.userId)}/tweets`, params);

    const parsed = xTimelineResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new XApiError(`Unexpected X timeline response: ${parsed.error.message}`, {
        transient: false,
        code: 'x_schema_mismatch',
      });
    }

    return parsed.data;
  }
}
