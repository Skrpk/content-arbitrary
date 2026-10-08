'use client';

import Script from 'next/script';
import { useCallback, useState } from 'react';
import { TELEGRAM_WEB_APP_SCRIPT, theme } from '@/lib/telegram/webapp-client';
import { RssBadge } from '../rss-badge';

/**
 * The source settings Mini App.
 *
 * Opened from the Settings button under /sourcestats or /addsource. Lists the
 * reviewer's own sources — channel by channel when they review several — with
 * their switches; each switch saves as soon as it is flipped. It also adds an
 * RSS / Atom feed, by URL, to the channel picked. As with the review pages,
 * every request carries Telegram's signed `initData`, and the server alone
 * decides which sources are theirs.
 */

interface SourceView {
  id: number;
  platform: 'x' | 'rss';
  username: string;
  /** `@handle` for X, the feed's title for RSS. */
  label: string;
  feedUrl: string | null;
  enabled: boolean;
  includeTextOnly: boolean;
}

interface ChannelView {
  id: number;
  name: string;
  sources: SourceView[];
}

type Setting = 'enabled' | 'includeTextOnly';

type Phase = 'waiting-for-telegram' | 'loading' | 'ready' | 'error';

const SETTINGS: { key: Setting; label: string; hint: string; platforms: SourceView['platform'][] }[] = [
  {
    key: 'enabled',
    label: 'Active',
    hint: 'Off pauses the source: kept, but not synced.',
    platforms: ['x', 'rss'],
  },
  {
    key: 'includeTextOnly',
    label: 'Posts without media',
    hint: 'Also mirror text-only posts, as text messages. Applies to new posts.',
    // Every feed entry is text already.
    platforms: ['x'],
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

export default function SettingsPage() {
  const [phase, setPhase] = useState<Phase>('waiting-for-telegram');
  const [message, setMessage] = useState<string | null>(null);
  const [channels, setChannels] = useState<ChannelView[]>([]);
  /** `${sourceId}:${setting}` of switches waiting for the server. */
  const [saving, setSaving] = useState<Set<string>>(new Set());

  const [feedUrl, setFeedUrl] = useState('');
  const [feedChannel, setFeedChannel] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [addResult, setAddResult] = useState<{ ok: boolean; text: string } | null>(null);

  /** Started from the Telegram script's ready callback, as in the review pages. */
  const load = useCallback(async () => {
    const app = window.Telegram?.WebApp;

    if (!app) {
      setPhase('error');
      setMessage('Telegram did not load. Open this from the Settings button in the bot chat.');
      return;
    }

    app.ready();
    app.expand();

    if (!app.initData) {
      setPhase('error');
      setMessage('This page only works when opened from the Settings button in Telegram.');
      return;
    }

    setPhase('loading');

    try {
      const response = await fetch('/api/telegram/webapp/sources', {
        headers: { Authorization: `tma ${app.initData}` },
      });
      const body = (await response.json()) as { channels?: ChannelView[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);

      setChannels(body.channels ?? []);
      setFeedChannel(body.channels?.[0]?.id ?? null);
      setPhase('ready');
    } catch (error: unknown) {
      setPhase('error');
      setMessage(error instanceof Error ? error.message : 'Could not load your sources.');
    }
  }, []);

  /** Flip one switch: shown at once, put back if the server refuses. */
  const toggle = useCallback(async (source: SourceView, setting: Setting) => {
    const app = window.Telegram?.WebApp;
    if (!app) return;

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
      const response = await fetch('/api/telegram/webapp/sources', {
        method: 'POST',
        headers: { Authorization: `tma ${app.initData}`, 'content-type': 'application/json' },
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
  }, []);

  /** Add a feed: checked on the server — fetched and parsed once — before it is stored. */
  const addFeed = useCallback(async () => {
    const app = window.Telegram?.WebApp;
    if (!app || feedChannel === null || feedUrl.trim() === '') return;

    setAdding(true);
    setAddResult(null);
    try {
      const response = await fetch('/api/telegram/webapp/sources/rss', {
        method: 'POST',
        headers: { Authorization: `tma ${app.initData}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url: feedUrl.trim(), workspaceId: feedChannel }),
      });
      const body = (await response.json()) as {
        error?: string;
        created?: boolean;
        entries?: number;
        workspaceId?: number;
        source?: SourceView;
      };
      if (!response.ok || !body.source) throw new Error(body.error ?? `Could not add (${response.status})`);

      const added = body.source;
      if (body.created) {
        setChannels((all) =>
          all.map((channel) =>
            channel.id === body.workspaceId ? { ...channel, sources: [...channel.sources, added] } : channel,
          ),
        );
        setFeedUrl('');
        setAddResult({
          ok: true,
          text:
            `✅ ${added.label} added. ${body.entries ?? 0} entries are in the feed now — they will not be ` +
            'sent; only new ones come to review.',
        });
      } else {
        setAddResult({ ok: true, text: `ℹ️ ${added.label} is already in your sources.` });
      }
    } catch (error: unknown) {
      setAddResult({ ok: false, text: error instanceof Error ? error.message : 'Could not add the feed.' });
    } finally {
      setAdding(false);
    }
  }, [feedChannel, feedUrl]);

  return (
    <>
      <Script
        src={TELEGRAM_WEB_APP_SCRIPT}
        strategy="afterInteractive"
        onReady={() => {
          void load();
        }}
      />

      <main
        style={{
          background: theme.bg,
          color: theme.text,
          minHeight: '100vh',
          padding: '1rem',
          boxSizing: 'border-box',
        }}
      >
        {phase === 'waiting-for-telegram' || phase === 'loading' ? (
          <p style={{ color: theme.hint }}>Loading…</p>
        ) : null}

        {phase === 'error' ? <p style={{ color: theme.hint }}>{message}</p> : null}

        {phase === 'ready' ? (
          <>
            <h1 style={{ fontSize: '1.05rem', fontWeight: 600, margin: '0 0 0.75rem' }}>Sources</h1>

            <section
              style={{
                background: theme.secondaryBg,
                borderRadius: '0.6rem',
                padding: '0.75rem 0.9rem',
                marginBottom: '1rem',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>➕ Add RSS feed</div>
              <input
                type="url"
                inputMode="url"
                placeholder="https://example.com/feed.xml"
                value={feedUrl}
                onChange={(event) => setFeedUrl(event.target.value)}
                style={inputStyle}
              />
              {channels.length > 1 ? (
                <select
                  value={feedChannel ?? ''}
                  onChange={(event) => setFeedChannel(Number(event.target.value))}
                  style={{ ...inputStyle, marginTop: '0.5rem' }}
                >
                  {channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      📢 {channel.name}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                type="button"
                disabled={adding || feedUrl.trim() === ''}
                onClick={() => {
                  void addFeed();
                }}
                style={{
                  width: '100%',
                  marginTop: '0.5rem',
                  padding: '0.55rem 0',
                  border: 'none',
                  borderRadius: '0.5rem',
                  background: theme.button,
                  color: theme.buttonText,
                  fontWeight: 600,
                  opacity: adding || feedUrl.trim() === '' ? 0.6 : 1,
                }}
              >
                {adding ? 'Checking the feed…' : 'Add feed'}
              </button>
              <div style={{ color: theme.hint, fontSize: '0.8rem', marginTop: '0.4rem' }}>
                The feed&apos;s own URL (RSS 2.0 or Atom), not the site&apos;s home page. What is in it now is not sent —
                only new entries come to review.
              </div>
              {addResult ? (
                <p
                  style={{
                    margin: '0.5rem 0 0',
                    fontSize: '0.85rem',
                    color: addResult.ok ? theme.text : '#e53935',
                  }}
                >
                  {addResult.text}
                </p>
              ) : null}
            </section>

            {channels.every((channel) => channel.sources.length === 0) ? (
              <p style={{ color: theme.hint }}>
                No sources yet. Add an X account in the chat with /addsource @username, or a feed above.
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
                        {source.platform === 'rss' ? <RssBadge /> : null}
                      </div>
                      {source.feedUrl ? (
                        <div
                          style={{
                            color: theme.hint,
                            fontSize: '0.8rem',
                            margin: '-0.25rem 0 0.3rem',
                            wordBreak: 'break-all',
                          }}
                        >
                          {source.feedUrl}
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
      </main>
    </>
  );
}
