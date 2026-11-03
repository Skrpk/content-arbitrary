import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/media/telegram/route';
import { shownMediaUrl, verifyMediaLink } from '@/lib/telegram-channel/media-link';
import { CDN, channelEmbed } from './channel-page-fakes';
import { withEnv } from './helpers';

const SECRET = 'c'.repeat(32);
const env = { CRON_SECRET: SECRET };

function queryOf(link: string): URLSearchParams {
  return new URL(link, 'https://example.vercel.app').searchParams;
}

describe('shownMediaUrl', () => {
  it('shows a channel post’s picture through the signed route, by its place in the post', () => {
    const link = shownMediaUrl('tg:spacenews/42', 1, { kind: 'photo', url: `${CDN}/old.jpg` }, SECRET)!;

    expect(link.startsWith('/api/media/telegram?')).toBe(true);
    expect(verifyMediaLink(queryOf(link), SECRET)).toEqual({ channel: 'spacenews', messageId: 42, index: 1 });
  });

  it('shows any other platform’s picture from where it was stored, and nothing for none', () => {
    expect(shownMediaUrl('1760000000000099001', 0, { kind: 'photo', url: 'https://pbs.twimg.com/a.jpg' }, SECRET)).toBe(
      'https://pbs.twimg.com/a.jpg',
    );
    expect(shownMediaUrl('tg:spacenews/42', 0, { kind: 'video' }, SECRET)).toBeNull();
  });
});

describe('verifyMediaLink', () => {
  const link = shownMediaUrl('tg:spacenews/42', 0, { kind: 'photo', url: `${CDN}/old.jpg` }, SECRET)!;

  it('refuses a link signed with another secret, or changed to another post or item', () => {
    expect(verifyMediaLink(queryOf(link), 'd'.repeat(32))).toBeNull();

    for (const [key, value] of [['post', 'spacenews/43'], ['post', 'otherchannel/42'], ['i', '1'], ['sig', 'x']]) {
      const query = queryOf(link);
      query.set(key!, value!);
      expect(verifyMediaLink(query, SECRET)).toBeNull();
    }
    expect(verifyMediaLink(new URLSearchParams(), SECRET)).toBeNull();
  });
});

describe('GET /api/media/telegram', () => {
  afterEach(() => vi.unstubAllGlobals());

  const get = (link: string) => withEnv(env, () => GET(new Request(new URL(link, 'https://example.vercel.app'))));

  it('sends the browser on to the picture as the post’s page has it now', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(channelEmbed({ id: 42, photos: [`${CDN}/fresh-a.jpg`, `${CDN}/fresh-b.jpg`] }), {
        headers: { 'content-type': 'text/html' },
      }),
    );
    vi.stubGlobal('fetch', fetchImpl);

    const link = await withEnv(env, () => shownMediaUrl('tg:spacenews/42', 1, { kind: 'photo', url: `${CDN}/old-b.jpg` })!);
    const response = await get(link);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${CDN}/fresh-b.jpg`);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://t.me/spacenews/42?embed=1&mode=tme');
  });

  it('answers 404, looking nothing up, for a link it did not sign', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    const response = await get('/api/media/telegram?post=spacenews/42&i=0&sig=forged');

    expect(response.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers 404 when the post no longer has the item', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(channelEmbed({ id: 42, text: 'Words only now' }), { headers: { 'content-type': 'text/html' } })),
    );

    const link = await withEnv(env, () => shownMediaUrl('tg:spacenews/42', 0, { kind: 'photo', url: `${CDN}/old.jpg` })!);
    expect((await get(link)).status).toBe(404);
  });
});
