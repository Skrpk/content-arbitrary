/**
 * What a person types to name a YouTube channel, read as one: its handle, or
 * its channel id. A video's link is not a channel — this follows channels, not
 * single videos — and is turned away as such.
 *
 *   @pbsspacetime · youtube.com/@pbsspacetime · https://www.youtube.com/@pbsspacetime/videos
 *   youtube.com/channel/UC7_gcs09iThXybpVgjHZ_7g · UC7_gcs09iThXybpVgjHZ_7g
 */

export type YouTubeChannelRef = { kind: 'handle'; handle: string } | { kind: 'id'; id: string };

export type NormalizedYouTubeChannel =
  | { ok: true; channel: YouTubeChannelRef }
  | { ok: false; reason: 'empty' | 'video' | 'invalid' };

/** A channel id: `UC` and 22 characters of YouTube's base64. */
const CHANNEL_ID = /^UC[0-9A-Za-z_-]{22}$/;
/** A handle: 3–30 letters, digits, dots, dashes and underscores (YouTube's rules, Latin only here). */
const HANDLE = /^[0-9A-Za-z._-]{3,30}$/;
const YOUTUBE_HOST = /^(?:www\.|m\.)?youtube\.com$/i;

export function normalizeYouTubeChannel(input: string): NormalizedYouTubeChannel {
  const value = input.trim();
  if (value === '') return { ok: false, reason: 'empty' };

  if (value.startsWith('@')) {
    const handle = value.slice(1);
    return HANDLE.test(handle) ? { ok: true, channel: { kind: 'handle', handle } } : { ok: false, reason: 'invalid' };
  }
  if (CHANNEL_ID.test(value)) return { ok: true, channel: { kind: 'id', id: value } };

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (/^youtu\.be$/i.test(url.hostname)) return { ok: false, reason: 'video' };
  if (!YOUTUBE_HOST.test(url.hostname)) return { ok: false, reason: 'invalid' };

  const [first, second] = url.pathname.split('/').filter(Boolean);
  if (!first) return { ok: false, reason: 'invalid' };
  if (first === 'watch' || first === 'shorts' || first === 'live' || first === 'embed' || url.searchParams.has('v')) {
    return { ok: false, reason: 'video' };
  }
  if (first.startsWith('@')) {
    const handle = decodeURIComponent(first.slice(1));
    return HANDLE.test(handle) ? { ok: true, channel: { kind: 'handle', handle } } : { ok: false, reason: 'invalid' };
  }
  if (first === 'channel' && second && CHANNEL_ID.test(second)) return { ok: true, channel: { kind: 'id', id: second } };
  return { ok: false, reason: 'invalid' };
}

/**
 * A channel's uploads playlist: its id with `UC` turned to `UU`, as YouTube
 * names it, so a sync need not ask for it (channels.list) every time.
 */
export function uploadsPlaylistOf(channelId: string): string {
  return `UU${channelId.slice(2)}`;
}

export function channelUrl(channelId: string): string {
  return `https://www.youtube.com/channel/${channelId}`;
}

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
