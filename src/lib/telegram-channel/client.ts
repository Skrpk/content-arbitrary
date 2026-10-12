import { ChannelPageError } from '@/lib/errors';
import { SITE_NAME, SITE_URL } from '@/lib/site';
import { parseChannelPage, type ChannelPage } from '@/lib/telegram-channel/parser';

/**
 * Fetches a public channel's web page from t.me — the page anyone gets in a
 * browser, no account and no API key.
 *
 * Only ever t.me, with a username already checked to be one
 * (src/lib/telegram-channel/username.ts), so what is fetched is never up to
 * the person adding the source. Redirects are not followed: t.me answers a
 * name with no public page — no such channel, a private one, a person, a bot,
 * a group — by sending the browser to the app's landing page, and that is
 * reported as such rather than read.
 */

export const CHANNEL_PAGE_MAX_BYTES = 3 * 1024 * 1024;
export const CHANNEL_PAGE_TIMEOUT_MS = 12_000;

const USER_AGENT = `Mozilla/5.0 (compatible; ${SITE_NAME.replace(/\s+/g, '')}/1.0; +${SITE_URL})`;

export interface FetchChannelOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The channel's latest posts — or, with `before`, the page of posts before that message. */
export async function fetchChannelPage(
  username: string,
  options: FetchChannelOptions & { before?: number } = {},
): Promise<ChannelPage> {
  const query = options.before ? `?before=${options.before}` : '';
  return parseChannelPage(await fetchPage(`https://t.me/s/${username}${query}`, options));
}

/**
 * One post on its own, through its embed — where an album shows all of its
 * items, with links to its media that are good now.
 */
export async function fetchChannelPost(
  username: string,
  messageId: number,
  options: FetchChannelOptions = {},
): Promise<ChannelPage['posts'][number] | null> {
  const page = parseChannelPage(await fetchPage(`https://t.me/${username}/${messageId}?embed=1&mode=tme`, options));
  return page.posts.find((post) => post.messageId === messageId) ?? null;
}

async function fetchPage(url: string, options: FetchChannelOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? CHANNEL_PAGE_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new ChannelPageError(`t.me did not answer within ${Math.round(timeoutMs / 1000)} s`, {
        transient: true,
        code: 'channel_timeout',
        cause: error,
      });
    }
    throw new ChannelPageError(`Could not reach t.me: ${error instanceof Error ? error.message : String(error)}`, {
      transient: true,
      code: 'channel_network',
      cause: error,
    });
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new ChannelPageError('No public channel by that name — it may not exist, be private, or not be a channel', {
      transient: false,
      code: 'channel_no_preview',
      status: response.status,
    });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const status = response.status;
    const transient = status === 429 || status >= 500;
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new ChannelPageError(status === 429 ? 't.me is rate limiting us (429)' : `t.me answered ${status}`, {
      transient,
      code: status === 429 ? 'channel_rate_limited' : 'channel_http_error',
      status,
      ...(status === 429 && Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
    });
  }

  return readCapped(response, CHANNEL_PAGE_MAX_BYTES);
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge(maxBytes);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function tooLarge(maxBytes: number): ChannelPageError {
  return new ChannelPageError(`The channel page is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`, {
    transient: false,
    code: 'channel_page_too_large',
  });
}
