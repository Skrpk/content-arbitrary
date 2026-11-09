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
