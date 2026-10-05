'use client';

import Script from 'next/script';
import { useCallback, useState } from 'react';
import { TELEGRAM_WEB_APP_SCRIPT, theme } from '@/lib/telegram/webapp-client';

/**
 * The source settings Mini App.
 *
 * Opened from the Settings button under /sources or /addsource. Lists the
 * reviewer's own sources — channel by channel when they review several — with
 * their switches; each switch saves as soon as it
 * is flipped. As with the review pages, every request carries Telegram's
 * signed `initData`, and the server alone decides which sources are theirs.
 */

interface SourceView {
  id: number;
  username: string;
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

const SETTINGS: { key: Setting; label: string; hint: string }[] = [
  { key: 'enabled', label: 'Active', hint: 'Off pauses the source: kept, but not synced.' },
  {
    key: 'includeTextOnly',
    label: 'Posts without media',
    hint: 'Also mirror text-only posts, as text messages. Applies to new posts.',
  },
];

export default function SettingsPage() {
  const [phase, setPhase] = useState<Phase>('waiting-for-telegram');
  const [message, setMessage] = useState<string | null>(null);
  const [channels, setChannels] = useState<ChannelView[]>([]);
  /** `${sourceId}:${setting}` of switches waiting for the server. */
  const [saving, setSaving] = useState<Set<string>>(new Set());

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
      setMessage(
        `@${source.username}: ${error instanceof Error ? error.message : 'could not save'}`,
      );
    } finally {
      setSaving((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, []);

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

            {channels.every((channel) => channel.sources.length === 0) ? (
              <p style={{ color: theme.hint }}>
                No sources yet. Add one in the chat with /addsource @username.
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
                      <div style={{ fontWeight: 600, marginBottom: '0.4rem' }}>@{source.username}</div>

                      {SETTINGS.map((setting) => {
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
