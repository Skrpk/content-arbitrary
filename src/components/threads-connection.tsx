'use client';

import { useCallback, useEffect, useState } from 'react';
import { readJson, type PanelTools } from '@/components/panel-tools';
import { theme } from '@/lib/telegram/webapp-client';

/**
 * Settings' Threads section: each channel's Threads account, connected or
 * not, with the button to connect or disconnect it.
 *
 * Connecting happens on the website: Meta's authorization window needs a
 * browser that comes back signed in. On the website the button goes straight
 * there; in a Mini App it opens the website's settings.
 */

interface AccountView {
  workspaceId: number;
  username: string;
  connectedAt: string;
  status: 'active' | 'expired' | 'refresh_failed';
}

interface ThreadsView {
  configured: boolean;
  via: 'mini-app' | 'website';
  websiteUrl: string | null;
  accounts: AccountView[];
}

const OUTCOME_MESSAGES: Record<string, { text: string; error: boolean }> = {
  connected: { text: 'Threads connected.', error: false },
  denied: { text: 'Threads was not connected: permission was not given.', error: true },
  expired: { text: 'That took too long or was started elsewhere. Try connecting again.', error: true },
  failed: { text: 'Threads could not be connected. Try again in a minute.', error: true },
};

const STATUS_HINTS: Record<AccountView['status'], string | null> = {
  active: null,
  refresh_failed: 'Could not renew access lately; it is retried. If this stays, connect again.',
  expired: 'Access ran out. Connect again to keep publishing.',
};

export function ThreadsConnection({
  channels,
  request,
  confirm,
  openLink,
}: { channels: { id: number; name: string }[] } & PanelTools) {
  const [view, setView] = useState<ThreadsView | null>(null);
  const [busy, setBusy] = useState<Set<number>>(new Set());
  // Back from Meta, the address says how it went.
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(() =>
    typeof window === 'undefined' ? null : (OUTCOME_MESSAGES[new URLSearchParams(window.location.search).get('threads') ?? ''] ?? null),
  );

  const load = useCallback(async () => {
    try {
      setView(await readJson<ThreadsView>(await request('/api/threads/accounts')));
    } catch {
      setView(null);
    }
  }, [request]);

  useEffect(() => {
    let cancelled = false;
    request('/api/threads/accounts')
      .then((response) => readJson<ThreadsView>(response))
      .then((loaded) => {
        if (!cancelled) setView(loaded);
      })
      .catch(() => {
        if (!cancelled) setView(null);
      });
    // Said once: the outcome comes out of the address.
    const params = new URLSearchParams(window.location.search);
    if (params.has('threads')) {
      params.delete('threads');
      const rest = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
    }
    return () => {
      cancelled = true;
    };
  }, [request]);

  const disconnect = useCallback(
    async (channel: { id: number; name: string }, username: string) => {
      if (!(await confirm(`Disconnect @${username} from ${channel.name}? Nothing more will be published there.`))) return;
      setBusy((all) => new Set(all).add(channel.id));
      try {
        await readJson(
          await request('/api/threads/accounts', {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspaceId: channel.id }),
          }),
        );
        setMessage({ text: `@${username} disconnected.`, error: false });
        await load();
      } catch (error) {
        setMessage({ text: error instanceof Error ? error.message : 'Could not disconnect.', error: true });
      } finally {
        setBusy((all) => {
          const next = new Set(all);
          next.delete(channel.id);
          return next;
        });
      }
    },
    [confirm, load, request],
  );

  if (!view || !view.configured) return null;

  const buttonStyle = (primary: boolean, disabled: boolean) => ({
    padding: '0.45rem 0.85rem',
    border: primary ? 'none' : `1px solid ${theme.hint}`,
    borderRadius: '0.5rem',
    background: primary ? theme.button : 'transparent',
    color: primary ? theme.buttonText : theme.text,
    fontWeight: primary ? 600 : 400,
    opacity: disabled ? 0.6 : 1,
  });

  return (
    <section
      style={{
        background: theme.secondaryBg,
        borderRadius: '0.6rem',
        padding: '0.75rem 0.9rem',
        marginBottom: '1.25rem',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>🧵 Threads</div>
      <div style={{ color: theme.hint, fontSize: '0.8rem', marginBottom: '0.5rem' }}>
        A Threads account each channel can publish to as well.
        {view.via === 'mini-app' ? ' Connecting opens the website, where you sign in with Telegram.' : ''}
      </div>
      {channels.map((channel) => {
        const account = view.accounts.find((item) => item.workspaceId === channel.id);
        const working = busy.has(channel.id);
        const hint = account ? STATUS_HINTS[account.status] : null;
        return (
          <div key={channel.id} style={{ marginTop: '0.5rem', opacity: working ? 0.6 : 1 }}>
            {channels.length > 1 ? <div style={{ fontSize: '0.85rem', marginBottom: '0.25rem' }}>📢 {channel.name}</div> : null}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
              <span style={{ flex: 1, minWidth: '10rem' }}>{account ? `@${account.username}` : 'Not connected'}</span>
              {account ? (
                <button type="button" disabled={working} onClick={() => void disconnect(channel, account.username)} style={buttonStyle(false, working)}>
                  Disconnect
                </button>
              ) : null}
              {!account || account.status !== 'active' ? (
                view.via === 'website' ? (
                  // A plain link: the start is an API route that sends the browser on to Meta.
                  <a href={`/api/threads/start?workspaceId=${channel.id}`} style={{ ...buttonStyle(true, working), textDecoration: 'none' }}>
                    {account ? 'Connect again' : 'Connect Threads'}
                  </a>
                ) : view.websiteUrl ? (
                  <button type="button" disabled={working} onClick={() => openLink(`${view.websiteUrl}/settings`)} style={buttonStyle(true, working)}>
                    {account ? 'Connect again on the website' : 'Connect on the website'}
                  </button>
                ) : null
              ) : null}
            </div>
            {hint ? <div style={{ color: '#e53935', fontSize: '0.8rem', marginTop: '0.25rem' }}>{hint}</div> : null}
          </div>
        );
      })}
      {message ? (
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: message.error ? '#e53935' : theme.hint }}>{message.text}</p>
      ) : null}
    </section>
  );
}
