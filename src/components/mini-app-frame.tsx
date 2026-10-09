'use client';

import Script from 'next/script';
import { useCallback, useState, type ReactNode } from 'react';
import type { PanelTools } from '@/components/panel-tools';
import { TELEGRAM_WEB_APP_SCRIPT, theme } from '@/lib/telegram/webapp-client';

/**
 * A page shared with the website, framed as a Mini App: it waits for
 * Telegram's script, then hands the page a fetch signed with the `initData`
 * Telegram gave it, Telegram's own confirm dialog, and its way of opening
 * links outside the app.
 */

type Phase = 'waiting-for-telegram' | 'ready' | 'error';

export function MiniAppFrame({
  opener,
  children,
}: {
  /** Where the page is opened from, for the message shown outside Telegram. */
  opener: string;
  children: (tools: PanelTools) => ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>('waiting-for-telegram');
  const [message, setMessage] = useState<string | null>(null);
  const [initData, setInitData] = useState('');

  const start = useCallback(() => {
    const app = window.Telegram?.WebApp;
    if (!app) {
      setPhase('error');
      setMessage(`Telegram did not load. Open this from ${opener} in the bot chat.`);
      return;
    }
    app.ready();
    app.expand();
    if (!app.initData) {
      setPhase('error');
      setMessage(`This page only works when opened from ${opener} in Telegram.`);
      return;
    }
    setInitData(app.initData);
    setPhase('ready');
  }, [opener]);

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
        {phase === 'ready' ? children({ request, confirm: confirmInTelegram, openLink: openOutside }) : null}
      </main>
    </>
  );
}

/** Ask in Telegram's own dialog where there is one. */
function confirmInTelegram(message: string): Promise<boolean> {
  const app = window.Telegram?.WebApp;
  if (app?.showConfirm) return new Promise((resolve) => app.showConfirm!(message, resolve));
  return Promise.resolve(window.confirm(message));
}

function openOutside(url: string): void {
  const app = window.Telegram?.WebApp;
  if (app?.openLink) app.openLink(url);
  else window.open(url, '_blank', 'noopener');
}
