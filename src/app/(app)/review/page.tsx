'use client';

import Script from 'next/script';
import { useCallback, useState } from 'react';
import { postIdFromLocation, TELEGRAM_WEB_APP_SCRIPT, theme } from '@/lib/telegram/webapp-client';

/**
 * The Edit Mini App.
 *
 * Opened from the Edit button under a post awaiting review. Telegram hands the
 * page a signed `initData` string; every request below carries it in an
 * `Authorization: tma …` header, and the server decides from that alone who is
 * asking and what they may touch. Nothing here is trusted — the page is public,
 * and the post id in the URL means nothing without a valid signature.
 */

interface PostDetails {
  postId: number;
  sourceUsername: string | null;
  /** `@handle`, or a feed's title. */
  sourceLabel: string | null;
  xPostUrl: string;
  mediaCount: number;
  caption: string;
  /** The workspace's footer, added under the text; shown, not edited. */
  footer: string | null;
  limit: number;
  hasOverflowMessage: boolean;
  edited: boolean;
}

type Phase = 'waiting-for-telegram' | 'loading' | 'ready' | 'saving' | 'saved' | 'error';

export default function ReviewPage() {
  const [phase, setPhase] = useState<Phase>('waiting-for-telegram');
  const [message, setMessage] = useState<string | null>(null);
  const [details, setDetails] = useState<PostDetails | null>(null);
  const [caption, setCaption] = useState('');

  /**
   * Started from the Telegram script's own ready callback rather than an
   * effect: the page has nothing to do until that script exists, and the
   * callback is the moment it does.
   */
  const load = useCallback(async () => {
    const app = window.Telegram?.WebApp;

    if (!app) {
      setPhase('error');
      setMessage('Telegram did not load. Open this from the Edit button in the bot chat.');
      return;
    }

    app.ready();
    app.expand();

    if (!app.initData) {
      setPhase('error');
      setMessage('This page only works when opened from the Edit button in Telegram.');
      return;
    }

    const postId = postIdFromLocation();
    if (postId === null) {
      setPhase('error');
      setMessage('No post to edit.');
      return;
    }

    setPhase('loading');

    try {
      const response = await fetch(`/api/telegram/webapp/caption?post=${postId}`, {
        headers: { Authorization: `tma ${app.initData}` },
      });

      const body = (await response.json()) as PostDetails & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);

      setDetails(body);
      setCaption(body.caption);
      setPhase('ready');
    } catch (error: unknown) {
      setPhase('error');
      setMessage(error instanceof Error ? error.message : 'Could not load this post.');
    }
  }, []);

  const limit = details?.limit ?? 1024;
  const trimmed = caption.trim();
  const tooLong = trimmed.length > limit;
  const empty = trimmed === '';
  const unchanged = details !== null && trimmed === details.caption.trim();

  const save = useCallback(async () => {
    const app = window.Telegram?.WebApp;
    if (!details || !app || tooLong || empty) return;

    setPhase('saving');
    setMessage(null);

    try {
      const response = await fetch('/api/telegram/webapp/caption', {
        method: 'POST',
        headers: {
          Authorization: `tma ${app.initData}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ postId: details.postId, caption: trimmed }),
      });

      const body = (await response.json()) as { error?: string; previewUpdated?: boolean };
      if (!response.ok) throw new Error(body.error ?? `Save failed (${response.status})`);

      setPhase('saved');
      setMessage(
        body.previewUpdated
          ? 'Saved. The preview in the chat now shows your text.'
          : 'Saved. Approve in the chat to publish it.',
      );

      // Give the confirmation a moment to be read, then hand control back.
      setTimeout(() => app.close(), 1200);
    } catch (error: unknown) {
      setPhase('ready');
      setMessage(error instanceof Error ? error.message : 'Could not save.');
    }
  }, [details, empty, tooLong, trimmed]);

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

        {phase === 'error' ? (
          <p style={{ color: theme.hint }}>{message}</p>
        ) : null}

        {details && phase !== 'error' ? (
          <>
            <header style={{ marginBottom: '0.75rem' }}>
              <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>
                {details.sourceLabel ?? 'Post'}
              </div>
              <div style={{ color: theme.hint, fontSize: '0.8rem' }}>
                {details.mediaCount === 0
                  ? 'Text post'
                  : details.mediaCount === 1
                    ? '1 media item'
                    : `${details.mediaCount} media items`}
                {details.edited ? ' · edited' : ''}
              </div>
            </header>

            <textarea
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
              disabled={phase === 'saving' || phase === 'saved'}
              rows={12}
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

            {details.footer ? (
              <div
                style={{
                  marginTop: '0.4rem',
                  padding: '0.6rem 0.75rem',
                  borderRadius: '0.5rem',
                  border: `1px dashed ${theme.hint}`,
                  color: theme.hint,
                  fontSize: '0.9rem',
                  whiteSpace: 'pre-wrap',
                }}
              >
                <div style={{ fontSize: '0.75rem', marginBottom: '0.2rem' }}>Footer, added under every post</div>
                {details.footer}
              </div>
            ) : null}

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: '0.8rem',
                color: tooLong ? '#e53935' : theme.hint,
                margin: '0.4rem 0 0.9rem',
              }}
            >
              <span>
                {trimmed.length} / {limit}
              </span>
              {details.hasOverflowMessage ? (
                <span>The original was long; the follow-up message will be dropped.</span>
              ) : null}
            </div>

            <button
              type="button"
              onClick={save}
              disabled={phase === 'saving' || phase === 'saved' || tooLong || empty || unchanged}
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
                opacity: phase === 'saving' || tooLong || empty || unchanged ? 0.5 : 1,
              }}
            >
              {phase === 'saving' ? 'Saving…' : phase === 'saved' ? 'Saved' : 'Save'}
            </button>

            {message ? (
              <p style={{ color: theme.hint, fontSize: '0.85rem', marginTop: '0.75rem' }}>
                {message}
              </p>
            ) : null}

            <p style={{ color: theme.hint, fontSize: '0.8rem', marginTop: '1rem' }}>
              Saving only changes the text. Approve or Reject in the chat as usual.
            </p>
          </>
        ) : null}
      </main>
    </>
  );
}
