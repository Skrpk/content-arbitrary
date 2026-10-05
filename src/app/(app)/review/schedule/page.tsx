'use client';

import Script from 'next/script';
import { useCallback, useMemo, useState } from 'react';
import { postIdFromLocation, TELEGRAM_WEB_APP_SCRIPT, theme } from '@/lib/telegram/webapp-client';

/**
 * The Schedule Mini App: pick when an approved post goes to the channel.
 *
 * Opened from the Schedule button under a post in review, or Change time under
 * one already scheduled. Times are picked in the phone's own zone and sent as
 * an exact moment, so the server never has to guess what "18:00" meant. As
 * with the other review pages, every request carries Telegram's signed
 * `initData`; the post id in the URL is not trusted on its own.
 */

interface PostContext {
  postId: number;
  sourceUsername: string | null;
  caption: string;
  scheduledFor: string | null;
  timezone: string | null;
  maxDaysAhead: number;
}

type Phase = 'waiting-for-telegram' | 'loading' | 'ready' | 'saving' | 'saved' | 'error';

const pad = (value: number) => String(value).padStart(2, '0');

/** The `YYYY-MM-DDTHH:mm` a datetime-local input expects, in local time. */
function toInputValue(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Today or tomorrow at `hour`:00 local time, whichever is still ahead. */
function nextAt(hour: number, dayOffset = 0): Date {
  const at = new Date();
  at.setDate(at.getDate() + dayOffset);
  at.setHours(hour, 0, 0, 0);
  if (dayOffset === 0 && at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
  return at;
}

function presets(): { label: string; at: Date }[] {
  const inAnHour = new Date(Date.now() + 60 * 60 * 1000);
  inAnHour.setSeconds(0, 0);
  return [
    { label: 'In 1 hour', at: inAnHour },
    { label: 'Tonight 20:00', at: nextAt(20) },
    { label: 'Tomorrow 09:00', at: nextAt(9, 1) },
    { label: 'Tomorrow 18:00', at: nextAt(18, 1) },
  ];
}

const formatLocal = (date: Date) =>
  new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);

export default function SchedulePage() {
  const [phase, setPhase] = useState<Phase>('waiting-for-telegram');
  const [message, setMessage] = useState<string | null>(null);
  const [context, setContext] = useState<PostContext | null>(null);
  const [value, setValue] = useState('');
  const [zone, setZone] = useState('UTC');
  /**
   * "Now", taken when the page loads and whenever the reviewer picks a time,
   * rather than during render — render must not depend on the clock.
   */
  const [now, setNow] = useState(0);
  const [shortcuts, setShortcuts] = useState<{ label: string; at: Date }[]>([]);

  const pick = useCallback((next: string) => {
    setNow(Date.now());
    setValue(next);
  }, []);

  /** Started from the Telegram script's ready callback, as in the other pages. */
  const load = useCallback(async () => {
    const app = window.Telegram?.WebApp;

    if (!app) {
      setPhase('error');
      setMessage('Telegram did not load. Open this from the Schedule button in the bot chat.');
      return;
    }

    app.ready();
    app.expand();

    if (!app.initData) {
      setPhase('error');
      setMessage('This page only works when opened from the Schedule button in Telegram.');
      return;
    }

    const postId = postIdFromLocation();
    if (postId === null) {
      setPhase('error');
      setMessage('No post to schedule.');
      return;
    }

    setZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    setPhase('loading');

    try {
      const response = await fetch(`/api/telegram/webapp/schedule?post=${postId}`, {
        headers: { Authorization: `tma ${app.initData}` },
      });
      const body = (await response.json()) as PostContext & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);

      const options = presets();
      setShortcuts(options);
      setContext(body);
      pick(toInputValue(body.scheduledFor ? new Date(body.scheduledFor) : options[0]!.at));
      setPhase('ready');
    } catch (error: unknown) {
      setPhase('error');
      setMessage(error instanceof Error ? error.message : 'Could not load this post.');
    }
  }, [pick]);

  // A datetime-local value without an offset is read as local time.
  const chosen = useMemo(() => {
    const at = value ? new Date(value) : null;
    return at && !Number.isNaN(at.getTime()) ? at : null;
  }, [value]);
  const valid = chosen !== null;
  const inPast = chosen !== null && chosen.getTime() <= now;

  const submit = useCallback(async () => {
    const app = window.Telegram?.WebApp;
    if (!context || !app || !chosen) return;

    setPhase('saving');
    setMessage(null);

    try {
      const response = await fetch('/api/telegram/webapp/schedule', {
        method: 'POST',
        headers: { Authorization: `tma ${app.initData}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          postId: context.postId,
          scheduledFor: chosen.toISOString(),
          timezone: zone,
        }),
      });
      const body = (await response.json()) as { error?: string; display?: string };
      if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);

      setPhase('saved');
      setMessage(`Scheduled for ${body.display ?? formatLocal(chosen)}.`);
      setTimeout(() => app.close(), 1200);
    } catch (error: unknown) {
      setPhase('ready');
      setMessage(error instanceof Error ? error.message : 'Could not schedule.');
    }
  }, [chosen, context, zone]);

  const busy = phase === 'saving' || phase === 'saved';
  const rescheduling = Boolean(context?.scheduledFor);

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

        {context && phase !== 'error' ? (
          <>
            <header style={{ marginBottom: '0.75rem' }}>
              <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>
                {rescheduling ? 'Change the time' : 'Schedule publishing'}
              </div>
              <div style={{ color: theme.hint, fontSize: '0.8rem' }}>
                {context.sourceUsername ? `@${context.sourceUsername}` : 'Post'}
                {context.scheduledFor
                  ? ` · now ${formatLocal(new Date(context.scheduledFor))}`
                  : ''}
              </div>
            </header>

            {context.caption ? (
              <p
                style={{
                  color: theme.hint,
                  fontSize: '0.85rem',
                  whiteSpace: 'pre-wrap',
                  maxHeight: '6rem',
                  overflow: 'hidden',
                  margin: '0 0 0.9rem',
                }}
              >
                {context.caption}
              </p>
            ) : null}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.9rem' }}>
              {shortcuts.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  disabled={busy}
                  onClick={() => pick(toInputValue(preset.at))}
                  style={{
                    padding: '0.45rem 0.7rem',
                    fontSize: '0.85rem',
                    fontFamily: 'inherit',
                    color: theme.text,
                    background: theme.secondaryBg,
                    border: 'none',
                    borderRadius: '1rem',
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <input
              type="datetime-local"
              value={value}
              min={now ? toInputValue(new Date(now)) : undefined}
              onChange={(event) => pick(event.target.value)}
              disabled={busy}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '0.75rem',
                fontSize: '1rem',
                fontFamily: 'inherit',
                color: theme.text,
                background: theme.secondaryBg,
                border: `1px solid ${inPast ? '#e53935' : 'transparent'}`,
                borderRadius: '0.5rem',
              }}
            />

            <div
              style={{
                fontSize: '0.8rem',
                color: inPast ? '#e53935' : theme.hint,
                margin: '0.4rem 0 0.9rem',
              }}
            >
              {inPast ? 'That time has already passed.' : `Your time zone: ${zone}`}
            </div>

            <button
              type="button"
              onClick={submit}
              disabled={busy || !valid || inPast}
              style={{
                width: '100%',
                padding: '0.85rem',
                fontSize: '1rem',
                fontWeight: 600,
                fontFamily: 'inherit',
                color: theme.buttonText,
                background: theme.button,
                border: 'none',
                borderRadius: '0.5rem',
                opacity: busy || !valid || inPast ? 0.5 : 1,
              }}
            >
              {phase === 'saving'
                ? 'Scheduling…'
                : phase === 'saved'
                  ? 'Scheduled'
                  : chosen && !inPast
                    ? `${rescheduling ? 'Move to' : 'Schedule for'} ${formatLocal(chosen)}`
                    : 'Schedule'}
            </button>

            {message ? (
              <p style={{ color: theme.hint, fontSize: '0.85rem', marginTop: '0.75rem' }}>{message}</p>
            ) : null}

            <p style={{ color: theme.hint, fontSize: '0.8rem', marginTop: '1rem' }}>
              The bot publishes it within a minute of this time. Telegram does not let bots use the
              channel&apos;s own scheduled messages, so it will not appear there.
            </p>
          </>
        ) : null}
      </main>
    </>
  );
}
