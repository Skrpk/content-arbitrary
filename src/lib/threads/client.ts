import { THREADS_API_VERSION, THREADS_GRAPH_URL, type ThreadsApp } from '@/lib/threads/config';

/**
 * The few Threads API calls connecting an account takes: the code for a
 * short-lived token, that for a long-lived one, refreshing it, and who it
 * belongs to.
 *
 * Tokens travel in query strings, as Meta's API has them, so a URL here is
 * never logged, and an error says what Threads said — never the request.
 */

const TIMEOUT_MS = 15_000;

export class ThreadsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ThreadsApiError';
  }
}

export interface ThreadsCallOptions {
  fetchImpl?: typeof fetch;
}

export interface LongLivedToken {
  accessToken: string;
  /** Seconds from now. */
  expiresIn: number;
}

/** The authorization code Meta sent back, for a short-lived token (an hour). */
export async function exchangeCode(app: ThreadsApp, code: string, options: ThreadsCallOptions = {}): Promise<string> {
  const body = new URLSearchParams({
    client_id: app.appId,
    client_secret: app.appSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: app.redirectUri,
  });
  const result = await call(`${THREADS_GRAPH_URL}/oauth/access_token`, { method: 'POST', body }, options);
  return stringField(result, 'access_token');
}

/** A short-lived token for a long-lived one: 60 days. */
export async function exchangeForLongLived(app: ThreadsApp, shortLived: string, options: ThreadsCallOptions = {}): Promise<LongLivedToken> {
  const params = new URLSearchParams({ grant_type: 'th_exchange_token', client_secret: app.appSecret, access_token: shortLived });
  return longLived(await call(`${THREADS_GRAPH_URL}/access_token?${params}`, { method: 'GET' }, options));
}

/** A long-lived token, at least a day old and not expired, for another 60 days. */
export async function refreshLongLived(token: string, options: ThreadsCallOptions = {}): Promise<LongLivedToken> {
  const params = new URLSearchParams({ grant_type: 'th_refresh_token', access_token: token });
  return longLived(await call(`${THREADS_GRAPH_URL}/refresh_access_token?${params}`, { method: 'GET' }, options));
}

/** Whose token it is: the account's id — as text, for it does not fit a JavaScript number — and username. */
export async function threadsMe(token: string, options: ThreadsCallOptions = {}): Promise<{ id: string; username: string }> {
  const params = new URLSearchParams({ fields: 'id,username', access_token: token });
  const result = await call(`${THREADS_GRAPH_URL}/${THREADS_API_VERSION}/me?${params}`, { method: 'GET' }, options);
  const id = result.id;
  if (typeof id !== 'string' || !/^\d{1,30}$/.test(id)) throw new ThreadsApiError('Threads returned no account id', 502);
  return { id, username: stringField(result, 'username') };
}

async function call(url: string, init: RequestInit, options: ThreadsCallOptions): Promise<Record<string, unknown>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
  } catch (error) {
    throw new ThreadsApiError(`Threads could not be reached: ${error instanceof Error ? error.name : 'error'}`, 502);
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !body || typeof body !== 'object') {
    throw new ThreadsApiError(`Threads answered ${response.status}: ${errorMessage(body)}`, response.status);
  }
  return body;
}

/** What Threads said went wrong, in either of the shapes it says it in, bounded. */
function errorMessage(body: Record<string, unknown> | null): string {
  const nested = body?.error && typeof body.error === 'object' ? (body.error as Record<string, unknown>).message : undefined;
  const message = typeof body?.error_message === 'string' ? body.error_message : typeof nested === 'string' ? nested : 'no details';
  return message.slice(0, 200);
}

function longLived(result: Record<string, unknown>): LongLivedToken {
  const expiresIn = Number(result.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new ThreadsApiError('Threads returned a token with no lifetime', 502);
  return { accessToken: stringField(result, 'access_token'), expiresIn };
}

function stringField(result: Record<string, unknown>, key: string): string {
  const value = result[key];
  if (typeof value !== 'string' || value === '') throw new ThreadsApiError(`Threads returned no ${key}`, 502);
  return value;
}

/* Publishing ------------------------------------------------------------- */

export type ThreadsContainerSpec =
  | { mediaType: 'TEXT'; text: string; attachment?: string | null }
  | { mediaType: 'IMAGE'; imageUrl: string; text?: string; carouselItem?: boolean }
  | { mediaType: 'VIDEO'; videoUrl: string; text?: string; carouselItem?: boolean }
  | { mediaType: 'CAROUSEL'; children: string[]; text?: string };

/** A media container for the account: Threads fetches its media and processes it. Its id. */
export async function createContainer(
  account: { threadsUserId: string; token: string },
  spec: ThreadsContainerSpec,
  options: ThreadsCallOptions = {},
): Promise<string> {
  const body = new URLSearchParams({ media_type: spec.mediaType, access_token: account.token });
  if (spec.text) body.set('text', spec.text);
  if (spec.mediaType === 'TEXT' && spec.attachment) body.set('text_attachment', JSON.stringify({ plaintext: spec.attachment }));
  if (spec.mediaType === 'IMAGE') body.set('image_url', spec.imageUrl);
  if (spec.mediaType === 'VIDEO') body.set('video_url', spec.videoUrl);
  if ((spec.mediaType === 'IMAGE' || spec.mediaType === 'VIDEO') && spec.carouselItem) body.set('is_carousel_item', 'true');
  if (spec.mediaType === 'CAROUSEL') body.set('children', spec.children.join(','));
  const result = await call(`${THREADS_GRAPH_URL}/${THREADS_API_VERSION}/${account.threadsUserId}/threads`, { method: 'POST', body }, options);
  return idField(result);
}

export type ContainerStatus = 'IN_PROGRESS' | 'FINISHED' | 'PUBLISHED' | 'ERROR' | 'EXPIRED';

/** Where Threads is with a container, and why it failed when it did. */
export async function containerStatus(
  token: string,
  containerId: string,
  options: ThreadsCallOptions = {},
): Promise<{ status: ContainerStatus; error: string | null }> {
  const params = new URLSearchParams({ fields: 'status,error_message', access_token: token });
  const result = await call(`${THREADS_GRAPH_URL}/${THREADS_API_VERSION}/${containerId}?${params}`, { method: 'GET' }, options);
  const status = String(result.status ?? '') as ContainerStatus;
  if (!['IN_PROGRESS', 'FINISHED', 'PUBLISHED', 'ERROR', 'EXPIRED'].includes(status)) {
    throw new ThreadsApiError(`Threads returned an unknown container status "${status.slice(0, 40)}"`, 502);
  }
  return { status, error: typeof result.error_message === 'string' ? result.error_message.slice(0, 300) : null };
}

/** Publish a processed container; the post's id. */
export async function publishContainer(
  account: { threadsUserId: string; token: string },
  containerId: string,
  options: ThreadsCallOptions = {},
): Promise<string> {
  const body = new URLSearchParams({ creation_id: containerId, access_token: account.token });
  const result = await call(`${THREADS_GRAPH_URL}/${THREADS_API_VERSION}/${account.threadsUserId}/threads_publish`, { method: 'POST', body }, options);
  return idField(result);
}

/** A published post's address on Threads, or null if Threads does not say. */
export async function permalinkOf(token: string, mediaId: string, options: ThreadsCallOptions = {}): Promise<string | null> {
  const params = new URLSearchParams({ fields: 'permalink', access_token: token });
  const result = await call(`${THREADS_GRAPH_URL}/${THREADS_API_VERSION}/${mediaId}?${params}`, { method: 'GET' }, options);
  return typeof result.permalink === 'string' && /^https:\/\//.test(result.permalink) ? result.permalink : null;
}

function idField(result: Record<string, unknown>): string {
  const id = result.id;
  if (typeof id !== 'string' || !/^\d{1,40}$/.test(id)) throw new ThreadsApiError('Threads returned no id', 502);
  return id;
}

/* Reading public profiles ------------------------------------------------- */

/** A public profile, as Threads' profile lookup gives it. */
export interface ThreadsProfile {
  username: string;
  name: string | null;
  followers: number | null;
}

/**
 * A public profile by its exact username, or null when Threads has none it
 * will show: private, under 100 followers, or no such account. Before the
 * app's review, Threads shows only its own official accounts.
 */
export async function profileLookup(token: string, username: string, options: ThreadsCallOptions = {}): Promise<ThreadsProfile | null> {
  const params = new URLSearchParams({ username, access_token: token });
  try {
    const result = await call(`${THREADS_GRAPH_URL}/${THREADS_API_VERSION}/profile_lookup?${params}`, { method: 'GET' }, options);
    if (typeof result.username !== 'string') return null;
    return {
      username: result.username,
      name: typeof result.name === 'string' ? result.name : null,
      followers: typeof result.follower_count === 'number' ? result.follower_count : null,
    };
  } catch (error) {
    if (error instanceof ThreadsApiError && (error.status === 400 || error.status === 404)) return null;
    throw error;
  }
}

/** A post as Threads gives it — the fields asked for, nothing assumed. */
export interface ThreadsApiPost {
  id: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  username?: string;
  text?: string;
  timestamp?: string;
  is_quote_post?: boolean;
  link_attachment_url?: string;
  children?: { data?: { id: string; media_type?: string; media_url?: string; thumbnail_url?: string }[] };
}

const POST_FIELDS =
  'id,media_type,media_url,thumbnail_url,permalink,username,text,timestamp,is_quote_post,link_attachment_url,children{id,media_type,media_url,thumbnail_url}';

/** A public profile's posts since a moment, newest first: one request, the run's budget counts it. */
export async function profilePosts(
  token: string,
  username: string,
  input: { since: Date; limit?: number },
  options: ThreadsCallOptions = {},
): Promise<ThreadsApiPost[]> {
  const params = new URLSearchParams({
    username,
    fields: POST_FIELDS,
    since: String(Math.floor(input.since.getTime() / 1000)),
    limit: String(input.limit ?? 25),
    access_token: token,
  });
  const result = await call(`${THREADS_GRAPH_URL}/${THREADS_API_VERSION}/profile_posts?${params}`, { method: 'GET' }, options);
  const data = Array.isArray(result.data) ? (result.data as ThreadsApiPost[]) : [];
  return data.filter((post) => typeof post?.id === 'string');
}

/** One post as it is now — its media's addresses afresh, for they expire. */
export async function threadsPost(token: string, mediaId: string, options: ThreadsCallOptions = {}): Promise<ThreadsApiPost> {
  const params = new URLSearchParams({ fields: POST_FIELDS, access_token: token });
  const result = await call(`${THREADS_GRAPH_URL}/${THREADS_API_VERSION}/${mediaId}?${params}`, { method: 'GET' }, options);
  return result as unknown as ThreadsApiPost;
}
