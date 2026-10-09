'use client';

import Script from 'next/script';
import { useCallback, useState } from 'react';
import { ReviewQueue } from '@/components/review-queue';
import { TELEGRAM_WEB_APP_SCRIPT, theme } from '@/lib/telegram/webapp-client';

/**
 * The review queue Mini App.
 *
 * Opened from the notification that new posts are waiting, or from /review.
 * The queue itself is the website's too (src/components/review-queue.tsx);
 * this page is its frame inside Telegram: it waits for Telegram's script, and
 * signs every request with the `initData` Telegram handed it.
 */

type Phase = 'waiting-for-telegram' | 'ready' | 'error';

/** Ask before publishing, in Telegram's own dialog where there is one. */
function confirmFirst(message: string): Promise<boolean> {
  const app = window.Telegram?.WebApp;
  if (app?.showConfirm) return new Promise((resolve) => app.showConfirm!(message, resolve));
  return Promise.resolve(window.confirm(message));
}

function openLink(url: string): void {
  const app = window.Telegram?.WebApp;
  if (app?.openLink) app.openLink(url);
  else window.open(url, '_blank', 'noopener');
}

export default function QueuePage() {
  const [phase, setPhase] = useState<Phase>('waiting-for-telegram');
  const [message, setMessage] = useState<string | null>(null);
  const [initData, setInitData] = useState('');
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);

  /** Started from the Telegram script's ready callback, as in the other pages. */
  const start = useCallback(() => {
    const app = window.Telegram?.WebApp;
    if (!app) {
      setPhase('error');
      setMessage('Telegram did not load. Open this from the review button in the bot chat.');
      return;
    }
    app.ready();
    app.expand();
    if (!app.initData) {
      setPhase('error');
      setMessage('This page only works when opened from the review button in Telegram.');
      return;
    }
    const wanted = Number(new URLSearchParams(window.location.search).get('workspace'));
    setWorkspaceId(Number.isSafeInteger(wanted) && wanted > 0 ? wanted : null);
    setInitData(app.initData);
    setPhase('ready');
  }, []);

  const request = useCallback(
    (path: string, init?: RequestInit) =>
      fetch(path, { ...init, headers: { ...init?.headers, Authorization: `tma ${initData}` } }),
    [initData],
  );

  return (
    <>
      <Script src={TELEGRAM_WEB_APP_SCRIPT} strategy="afterInteractive" onReady={start} />

      <main
        style={{
          background: theme.bg,
          color: theme.text,
          minHeight: '100vh',
          padding: '1rem',
          boxSizing: 'border-box',
          maxWidth: '40rem',
          margin: '0 auto',
        }}
      >
        {phase === 'waiting-for-telegram' ? <p style={{ color: theme.hint }}>Loading…</p> : null}
        {phase === 'error' ? <p style={{ color: theme.hint }}>{message}</p> : null}
        {phase === 'ready' ? (
          <>
            <h1 style={{ fontSize: '1.05rem', fontWeight: 600, margin: '0 0 0.25rem' }}>Review queue</h1>
            <ReviewQueue
              surface="mini-app"
              request={request}
              initialWorkspaceId={workspaceId}
              confirm={confirmFirst}
              openLink={openLink}
            />
          </>
        ) : null}
      </main>
    </>
  );
}
