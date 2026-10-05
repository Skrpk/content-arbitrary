'use client';

import Script from 'next/script';
import { useCallback, useState } from 'react';
import { postIdFromLocation, TELEGRAM_WEB_APP_SCRIPT, theme } from '@/lib/telegram/webapp-client';

/**
 * The "Other" Mini App: reject a post and say why in your own words.
 *
 * Opened from the Other button in the list of rejection reasons. Like the
 * editor, it proves who is asking with Telegram's signed `initData` on every
 * request; the post id in the URL is not trusted on its own.
 */

interface PostContext {
  postId: number;
  sourceUsername: string | null;
  caption: string;
  noteLimit: number;
}

type Phase = 'waiting-for-telegram' | 'loading' | 'ready' | 'saving' | 'saved' | 'error';

export default function RejectPage() {
  const [phase, setPhase] = useState<Phase>('waiting-for-telegram');
  const [message, setMessage] = useState<string | null>(null);
  const [context, setContext] = useState<PostContext | null>(null);
  const [note, setNote] = useState('');

  /** Started from the Telegram script's ready callback, as in the editor. */
  const load = useCallback(async () => {
    const app = window.Telegram?.WebApp;

    if (!app) {
      setPhase('error');
      setMessage('Telegram did not load. Open this from the Other button in the bot chat.');
      return;
    }

    app.ready();
    app.expand();

    if (!app.initData) {
      setPhase('error');
      setMessage('This page only works when opened from the Other button in Telegram.');
      return;
    }

    const postId = postIdFromLocation();
    if (postId === null) {
      setPhase('error');
      setMessage('No post to reject.');
      return;
    }

    setPhase('loading');

    try {
      const response = await fetch(`/api/telegram/webapp/reject?post=${postId}`, {
        headers: { Authorization: `tma ${app.initData}` },
      });

      const body = (await response.json()) as PostContext & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);

      setContext(body);
      setPhase('ready');
    } catch (error: unknown) {
      setPhase('error');
      setMessage(error instanceof Error ? error.message : 'Could not load this post.');
    }
  }, []);

  const limit = context?.noteLimit ?? 500;
  const trimmed = note.trim();
  const tooLong = trimmed.length > limit;

  const submit = useCallback(async () => {
    const app = window.Telegram?.WebApp;
    if (!context || !app || tooLong) return;

    setPhase('saving');
    setMessage(null);

    try {
      const response = await fetch('/api/telegram/webapp/reject', {
        method: 'POST',
        headers: {
          Authorization: `tma ${app.initData}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ postId: context.postId, note: trimmed }),
      });

      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);

      setPhase('saved');
      setMessage('Rejected. It will not be published.');
      setTimeout(() => app.close(), 1200);
    } catch (error: unknown) {
      setPhase('ready');
      setMessage(error instanceof Error ? error.message : 'Could not reject.');
    }
  }, [context, tooLong, trimmed]);

  const busy = phase === 'saving' || phase === 'saved';

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
              <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>Why does it not fit?</div>
              <div style={{ color: theme.hint, fontSize: '0.8rem' }}>
                {context.sourceUsername ? `@${context.sourceUsername}` : 'Post'}
              </div>
            </header>

            {context.caption ? (
              <p
                style={{
                  color: theme.hint,
                  fontSize: '0.85rem',
                  whiteSpace: 'pre-wrap',
                  maxHeight: '8.5rem',
                  overflow: 'hidden',
                  margin: '0 0 0.75rem',
                }}
              >
                {context.caption}
              </p>
            ) : null}

            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={busy}
              rows={5}
              placeholder="In your own words (optional)"
              spellCheck
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '0.75rem',
                fontSize: '1rem',
                lineHeight: 1.5,
                fontFamily: 'inherit',
                color: theme.text,
                background: theme.secondaryBg,
                border: `1px solid ${tooLong ? '#e53935' : 'transparent'}`,
                borderRadius: '0.5rem',
                resize: 'vertical',
              }}
            />

            <div
              style={{
                fontSize: '0.8rem',
                color: tooLong ? '#e53935' : theme.hint,
                margin: '0.4rem 0 0.9rem',
              }}
            >
              {trimmed.length} / {limit}
            </div>

            <button
              type="button"
              onClick={submit}
              disabled={busy || tooLong}
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
                opacity: busy || tooLong ? 0.5 : 1,
              }}
            >
              {phase === 'saving' ? 'Rejecting…' : phase === 'saved' ? 'Rejected' : 'Reject'}
            </button>

            {message ? (
              <p style={{ color: theme.hint, fontSize: '0.85rem', marginTop: '0.75rem' }}>
                {message}
              </p>
            ) : null}

            <p style={{ color: theme.hint, fontSize: '0.8rem', marginTop: '1rem' }}>
              Closing this without pressing Reject changes nothing.
            </p>
          </>
        ) : null}
      </main>
    </>
  );
}
