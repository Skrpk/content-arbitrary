'use client';

import { useCallback, useEffect, useState } from 'react';
import { PlatformBadge } from '@/app/(app)/platform-badge';
import { readJson, type PanelTools } from '@/components/panel-tools';
import { theme } from '@/lib/telegram/webapp-client';

/**
 * Settings, for the Mini App and the website alike.
 *
 * Sets how often each channel's reviewer hears about the review queue, and
 * lists the reviewer's own sources — channel by channel when they review
 * several — with their switches; each switch saves as soon as it is flipped.
 * It also adds an RSS / Atom feed, by URL, to the channel picked. Every
 * request goes through the frame's `request`, which proves who is asking, and
 * the server alone decides which sources are theirs.
 */

interface SourceView {
  id: number;
  platform: 'x' | 'rss' | 'telegram';
  username: string;
  /** `@handle` for X and a Telegram channel, the feed's title for RSS. */
  label: string;
  feedUrl: string | null;
  /** A Telegram channel's t.me link. */
  channelUrl: string | null;
  enabled: boolean;
  includeTextOnly: boolean;
}

interface ChannelView {
  id: number;
  name: string;
  /** Minutes between review queue notifications; null sends each post to the chat. */
  reviewDigestMinutes: number | null;
  /** For a day or more: the hour it comes at, in `reviewDigestTimezone`; null for whenever it is due. */
  reviewDigestHour: number | null;
  reviewDigestTimezone: string | null;
  sources: SourceView[];
}

type ReviewLink = 'mini_app' | 'website';

const REVIEW_LINK_CHOICES: { value: ReviewLink; label: string; hint: string }[] = [
  { value: 'mini_app', label: 'The Mini App, inside Telegram', hint: 'Right where the notification is.' },
  { value: 'website', label: 'The website, in your browser', hint: '' },
];

const DAY_MINUTES = 24 * 60;

/** The intervals offered, in minutes; `chat` and `days` are the two that are not one number. */
const DIGEST_CHOICES: { value: string; label: string }[] = [
  { value: 'chat', label: 'Each post in the chat, as it arrives' },
  { value: '15', label: 'Every 15 minutes' },
  { value: '60', label: 'Every hour' },
  { value: '180', label: 'Every 3 hours' },
  { value: '360', label: 'Every 6 hours' },
  { value: '720', label: 'Every 12 hours' },
  { value: String(DAY_MINUTES), label: 'Once a day' },
  { value: 'days', label: 'Every few days…' },
  { value: String(7 * DAY_MINUTES), label: 'Once a week' },
];

/** Which choice a stored interval is: a preset, a number of days, or — set some other way — itself. */
function digestChoiceOf(minutes: number | null): string {
  if (minutes === null) return 'chat';
  if (DIGEST_CHOICES.some((choice) => choice.value === String(minutes))) return String(minutes);
  if (minutes % DAY_MINUTES === 0) return 'days';
  return String(minutes);
}

type Setting = 'enabled' | 'includeTextOnly';

type Phase = 'loading' | 'ready' | 'error';

const SETTINGS: { key: Setting; label: string; hint: string; platforms: SourceView['platform'][] }[] = [
  {
    key: 'enabled',
    label: 'Active',
    hint: 'Off pauses the source: kept, but not synced.',
    platforms: ['x', 'rss', 'telegram'],
  },
  {
    key: 'includeTextOnly',
    label: 'Posts without media',
    hint: 'Also mirror text-only posts, as text messages. Applies to new posts.',
    // Every feed entry is text already.
    platforms: ['x', 'telegram'],
  },
];

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.55rem 0.65rem',
  borderRadius: '0.5rem',
  border: `1px solid ${theme.hint}`,
  background: theme.bg,
  color: theme.text,
  fontSize: '0.95rem',
} as const;

export function SettingsPanel({ request }: Pick<PanelTools, 'request'>) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [channels, setChannels] = useState<ChannelView[]>([]);
  /** `${sourceId}:${setting}` of switches waiting for the server. */
  const [saving, setSaving] = useState<Set<string>>(new Set());

  /** Channels whose interval is being saved. */
  const [savingDigest, setSavingDigest] = useState<Set<number>>(new Set());
  /** The number typed for "every few days", per channel, before it is saved. */
  const [digestDays, setDigestDays] = useState<Record<number, string>>({});
  const [digestMessage, setDigestMessage] = useState<string | null>(null);

  /** Where the bot's review buttons take this person; null until known, or with no website to choose. */
  const [account, setAccount] = useState<{ reviewLink: ReviewLink; websiteUrl: string } | null>(null);
  const [linkMessage, setLinkMessage] = useState<string | null>(null);


  useEffect(() => {
    let cancelled = false;
    request('/api/account')
      .then((response) => readJson<{ reviewLink: ReviewLink; websiteUrl: string | null }>(response))
      .then((body) => {
        if (!cancelled && body.websiteUrl) setAccount({ reviewLink: body.reviewLink, websiteUrl: body.websiteUrl });
      })
      // Only this one choice is missing without it; the rest of the page stands.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [request]);

  useEffect(() => {
    let cancelled = false;
    request('/api/telegram/webapp/sources')
      .then((response) => readJson<{ channels?: ChannelView[] }>(response))
      .then((body) => {
        if (cancelled) return;
        setChannels(body.channels ?? []);
        setPhase('ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPhase('error');
        setMessage(error instanceof Error ? error.message : 'Could not load your sources.');
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  /** Flip one switch: shown at once, put back if the server refuses. */
  const toggle = useCallback(async (source: SourceView, setting: Setting) => {
    const key = `${source.id}:${setting}`;
    const value = !source[setting];
    const apply = (next: boolean) =>
      setChannels((all) =>
        all.map((channel) => ({
          ...channel,
          sources: channel.sources.map((item) =>
            item.id === source.id ? { ...item, [setting]: next } : item,
          ),
        })),
      );

    apply(value);
    setSaving((current) => new Set(current).add(key));
    setMessage(null);

    try {
      const response = await request('/api/telegram/webapp/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceId: source.id, [setting]: value }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Save failed (${response.status})`);
    } catch (error: unknown) {
      apply(!value);
      setMessage(`${source.label}: ${error instanceof Error ? error.message : 'could not save'}`);
    } finally {
      setSaving((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, [request]);

  /** Save how often a channel's reviewer hears about the queue: shown at once, put back if refused. */
  const saveDigest = useCallback(async (channel: ChannelView, minutes: number | null, hour?: number | null) => {
    const previous = {
      reviewDigestMinutes: channel.reviewDigestMinutes,
      reviewDigestHour: channel.reviewDigestHour,
      reviewDigestTimezone: channel.reviewDigestTimezone,
    };
    // The hour is in this browser's zone — the reviewer's own, wherever they are.
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const next = {
      reviewDigestMinutes: minutes,
      ...(hour === undefined ? {} : { reviewDigestHour: hour, reviewDigestTimezone: hour === null ? null : timezone }),
    };
    const apply = (change: Partial<ChannelView>) =>
      setChannels((all) => all.map((item) => (item.id === channel.id ? { ...item, ...change } : item)));

    apply(next);
    setSavingDigest((current) => new Set(current).add(channel.id));
    setDigestMessage(null);

    try {
      const response = await request('/api/telegram/webapp/channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: channel.id,
          reviewDigestMinutes: minutes,
          ...(hour === undefined ? {} : { reviewDigestHour: hour, ...(hour === null ? {} : { timezone }) }),
        }),
      });
      const body = (await response.json()) as { error?: string; queueActive?: boolean };
      if (!response.ok) throw new Error(body.error ?? `Save failed (${response.status})`);
      if (minutes !== null && body.queueActive === false) {
        setDigestMessage('Saved — but the review queue needs APP_BASE_URL set, so posts still come to the chat.');
      }
    } catch (error: unknown) {
      apply(previous);
      setDigestMessage(`${channel.name}: ${error instanceof Error ? error.message : 'could not save'}`);
    } finally {
      setSavingDigest((current) => {
        const next = new Set(current);
        next.delete(channel.id);
        return next;
      });
    }
  }, [request]);

  /** Save where the review buttons go: shown at once, put back if refused. */
  const saveReviewLink = useCallback(
    async (next: ReviewLink) => {
      const previous = account?.reviewLink;
      setAccount((current) => current && { ...current, reviewLink: next });
      setLinkMessage(null);
      try {
        await readJson(
          await request('/api/account', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reviewLink: next }),
          }),
        );
      } catch (error: unknown) {
        if (previous) setAccount((current) => current && { ...current, reviewLink: previous });
        setLinkMessage(error instanceof Error ? error.message : 'Could not save.');
      }
    },
    [account, request],
  );

  return (
    <>
      {phase === 'loading' ? (
        <p style={{ color: theme.hint }}>Loading…</p>
      ) : null}

      {phase === 'error' ? <p style={{ color: theme.hint }}>{message}</p> : null}

      {phase === 'ready' ? (
        <>
          <h1 style={{ fontSize: '1.05rem', fontWeight: 600, margin: '0 0 0.75rem' }}>Review</h1>

          <section
            style={{
              background: theme.secondaryBg,
              borderRadius: '0.6rem',
              padding: '0.75rem 0.9rem',
              marginBottom: '1.25rem',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>🔔 New posts for review</div>
            <div style={{ color: theme.hint, fontSize: '0.8rem', marginBottom: '0.5rem' }}>
              Collected in the review queue, best Radar score first, with one notification at most this often —
              and only when something new has come in. Or each post in the chat, with its own buttons.
            </div>
            {channels.map((channel) => {
              const choice = digestChoiceOf(channel.reviewDigestMinutes);
              const busy = savingDigest.has(channel.id);
              const storedDays =
                channel.reviewDigestMinutes !== null && channel.reviewDigestMinutes % DAY_MINUTES === 0
                  ? String(channel.reviewDigestMinutes / DAY_MINUTES)
                  : '2';
              const days = digestDays[channel.id] ?? storedDays;
              const daysValue = Number(days);
              const daysValid = Number.isInteger(daysValue) && daysValue >= 1 && daysValue <= 90;
              const extra = DIGEST_CHOICES.some((option) => option.value === choice)
                ? null
                : { value: choice, label: `Every ${channel.reviewDigestMinutes} minutes` };

              return (
                <div key={channel.id} style={{ marginTop: '0.5rem', opacity: busy ? 0.6 : 1 }}>
                  {channels.length > 1 ? (
                    <div style={{ fontSize: '0.85rem', marginBottom: '0.25rem' }}>📢 {channel.name}</div>
                  ) : null}
                  <select
                    value={choice}
                    disabled={busy}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === 'chat') void saveDigest(channel, null);
                      else if (value === 'days') void saveDigest(channel, Math.max(2, Number(storedDays)) * DAY_MINUTES);
                      else void saveDigest(channel, Number(value));
                    }}
                    style={inputStyle}
                  >
                    {[...DIGEST_CHOICES, ...(extra ? [extra] : [])].map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {choice === 'days' ? (
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem' }}>
                      <span>Every</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={90}
                        value={days}
                        disabled={busy}
                        onChange={(event) =>
                          setDigestDays((all) => ({ ...all, [channel.id]: event.target.value }))
                        }
                        style={{ ...inputStyle, width: '5rem' }}
                      />
                      <span style={{ flex: 1 }}>days</span>
                      <button
                        type="button"
                        disabled={busy || !daysValid || daysValue * DAY_MINUTES === channel.reviewDigestMinutes}
                        onClick={() => {
                          void saveDigest(channel, daysValue * DAY_MINUTES);
                        }}
                        style={{
                          padding: '0.5rem 0.9rem',
                          border: 'none',
                          borderRadius: '0.5rem',
                          background: theme.button,
                          color: theme.buttonText,
                          fontWeight: 600,
                          opacity: busy || !daysValid || daysValue * DAY_MINUTES === channel.reviewDigestMinutes ? 0.6 : 1,
                        }}
                      >
                        Save
                      </button>
                    </div>
                  ) : null}
                  {channel.reviewDigestMinutes !== null && channel.reviewDigestMinutes >= DAY_MINUTES ? (
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem' }}>
                      <span>at</span>
                      <select
                        value={channel.reviewDigestHour === null ? 'any' : String(channel.reviewDigestHour)}
                        disabled={busy}
                        onChange={(event) => {
                          const value = event.target.value;
                          void saveDigest(channel, channel.reviewDigestMinutes, value === 'any' ? null : Number(value));
                        }}
                        style={{ ...inputStyle, width: 'auto', flex: 1 }}
                      >
                        <option value="any">any time — as soon as it is due</option>
                        {Array.from({ length: 24 }, (_, hour) => (
                          <option key={hour} value={hour}>
                            {String(hour).padStart(2, '0')}:00
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                  {channel.reviewDigestHour !== null &&
                  channel.reviewDigestTimezone &&
                  channel.reviewDigestMinutes !== null &&
                  channel.reviewDigestMinutes >= DAY_MINUTES ? (
                    <div style={{ color: theme.hint, fontSize: '0.75rem', marginTop: '0.2rem' }}>
                      Your time, {channel.reviewDigestTimezone.replace(/_/g, ' ')} — kept when the clocks change. Sent
                      only when something new has come in.
                    </div>
                  ) : null}
                </div>
              );
            })}
            {digestMessage ? (
              <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: '#e53935' }}>{digestMessage}</p>
            ) : null}
          </section>

          {account ? (
            <section
              style={{
                background: theme.secondaryBg,
                borderRadius: '0.6rem',
                padding: '0.75rem 0.9rem',
                marginBottom: '1.25rem',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>🔗 &ldquo;Open review queue&rdquo; opens</div>
              <div style={{ color: theme.hint, fontSize: '0.8rem', marginBottom: '0.4rem' }}>
                For the bot&apos;s buttons — the notification and /review. Yours alone, for every channel.
              </div>
              {REVIEW_LINK_CHOICES.map((choice) => (
                <label
                  key={choice.value}
                  style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem', padding: '0.35rem 0', cursor: 'pointer' }}
                >
                  <input
                    type="radio"
                    name="review-link"
                    checked={account.reviewLink === choice.value}
                    onChange={() => {
                      void saveReviewLink(choice.value);
                    }}
                    style={{ marginTop: '0.3rem', accentColor: theme.button }}
                  />
                  <span>
                    <span style={{ display: 'block' }}>{choice.label}</span>
                    <span style={{ display: 'block', color: theme.hint, fontSize: '0.8rem' }}>
                      {choice.value === 'website' ? account.websiteUrl.replace(/^https:\/\//, '') : choice.hint}
                    </span>
                  </span>
                </label>
              ))}
              {linkMessage ? (
                <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: '#e53935' }}>{linkMessage}</p>
              ) : null}
            </section>
          ) : null}

          <h1 style={{ fontSize: '1.05rem', fontWeight: 600, margin: '0 0 0.75rem' }}>Sources</h1>

          <p style={{ color: theme.hint, fontSize: '0.85rem', margin: '0 0 0.75rem' }}>
            Each source&apos;s options. Add sources — X accounts, Telegram channels, RSS feeds — on the Sources page.
          </p>

          {channels.every((channel) => channel.sources.length === 0) ? (
            <p style={{ color: theme.hint }}>
              No sources yet. Add one on the Sources page.
            </p>
          ) : null}

          {message ? (
            <p style={{ color: '#e53935', fontSize: '0.85rem', margin: '0 0 0.75rem' }}>{message}</p>
          ) : null}

          {channels.map((channel) => {
            return (
              <div key={channel.id}>
                {/* Named only when there is more than one to tell apart. */}
                {channels.length > 1 ? (
                  <h2 style={{ fontSize: '0.95rem', fontWeight: 600, margin: '1rem 0 0.5rem' }}>
                    📢 {channel.name}
                  </h2>
                ) : null}
                {channel.sources.map((source) => (
                  <section
                    key={source.id}
                    style={{
                      background: theme.secondaryBg,
                      borderRadius: '0.6rem',
                      padding: '0.75rem 0.9rem',
                      marginBottom: '0.75rem',
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: '0.4rem' }}>
                      {source.label}
                      <PlatformBadge platform={source.platform} />
                    </div>
                    {source.feedUrl || source.channelUrl ? (
                      <div
                        style={{
                          color: theme.hint,
                          fontSize: '0.8rem',
                          margin: '-0.25rem 0 0.3rem',
                          wordBreak: 'break-all',
                        }}
                      >
                        {source.feedUrl ?? source.channelUrl}
                      </div>
                    ) : null}

                    {SETTINGS.filter((setting) => setting.platforms.includes(source.platform)).map((setting) => {
                      const busy = saving.has(`${source.id}:${setting.key}`);
                      return (
                        <label
                          key={setting.key}
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            justifyContent: 'space-between',
                            gap: '0.75rem',
                            padding: '0.45rem 0',
                            opacity: busy ? 0.6 : 1,
                          }}
                        >
                          <span>
                            <span style={{ display: 'block' }}>{setting.label}</span>
                            <span style={{ display: 'block', color: theme.hint, fontSize: '0.8rem' }}>
                              {setting.hint}
                            </span>
                          </span>
                          <input
                            type="checkbox"
                            checked={source[setting.key]}
                            disabled={busy}
                            onChange={() => {
                              void toggle(source, setting.key);
                            }}
                            style={{ width: '1.3rem', height: '1.3rem', flexShrink: 0, accentColor: theme.button }}
                          />
                        </label>
                      );
                    })}
                  </section>
                ))}
              </div>
            );
          })}
        </>
      ) : null}
    </>
  );
}
