'use client';

import Script from 'next/script';
import { useCallback, useState } from 'react';
import { fromQueue, TELEGRAM_WEB_APP_SCRIPT, theme } from '@/lib/telegram/webapp-client';
import { RssBadge } from '../rss-badge';

/**
 * The review queue Mini App.
 *
 * Opened from the notification that new posts are waiting, or from /review.
 * Every post awaiting a decision in the reviewer's channels, best Radar score
 * first — Radar orders the list, it never leaves anything off it. Approve
 * publishes to the channel there and then; Reject asks why, as the chat does;
 * Edit and Schedule open their own pages and come back here.
 *
 * As with the other Mini Apps, every request carries Telegram's signed
 * `initData`, and the server alone decides which posts are the reviewer's.
 */

interface QueueItem {
  id: number;
  platform: 'x' | 'rss';
  sourceLabel: string | null;
  url: string;
  postedAt: string | null;
  text: string;
  fullText: string | null;
  media: { kind: 'photo' | 'video'; imageUrl: string | null }[];
  score: {
    score: number;
    predictedDecision: 'approve' | 'reject';
    reason: string | null;
    possiblyAlreadyCovered: boolean;
  } | null;
  edited: boolean;
}

interface Channel {
  id: number;
  name: string;
  waiting: number;
  items: QueueItem[];
}

interface QueueResponse {
  channels: Channel[];
  limit: number;
  reasons: { value: string; label: string }[];
  noteLimit: number;
}

type Phase = 'waiting-for-telegram' | 'loading' | 'ready' | 'error';

/** Where one card is: undecided, picking a reason, on its way, or settled. */
type CardState =
  | { kind: 'open' }
  | { kind: 'choosing-reason' }
  | { kind: 'writing-note'; note: string }
  | { kind: 'sending'; what: 'approve' | 'reject' }
  | { kind: 'done'; outcome: string };

/** Lines of text a card shows before "More". */
const PREVIEW_CHARS = 420;

const button = {
  flex: 1,
  padding: '0.6rem 0',
  border: 'none',
  borderRadius: '0.55rem',
  fontSize: '0.95rem',
  fontWeight: 600,
} as const;

const smallButton = {
  padding: '0.4rem 0.6rem',
  border: `1px solid ${theme.hint}`,
  borderRadius: '0.5rem',
  background: 'transparent',
  color: theme.text,
  fontSize: '0.8rem',
} as const;

/** "3h ago", "2d ago". */
function ago(iso: string | null): string {
  if (!iso) return '';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Green for a likely approval, amber for a maybe, grey for a likely no. */
function scoreColour(score: number): string {
  if (score >= 70) return '#2e9e4f';
  if (score >= 45) return '#d08a00';
  return '#8a8f94';
}

/** Ask before publishing, in Telegram's own dialog where there is one. */
function confirmFirst(message: string): Promise<boolean> {
  const app = window.Telegram?.WebApp;
  if (app?.showConfirm) return new Promise((resolve) => app.showConfirm!(message, resolve));
  return Promise.resolve(window.confirm(message));
}

/** The channel to open on: the one the notification was for, if it is one of theirs. */
function channelFromLocation(channels: Channel[]): number | null {
  const wanted = Number(new URLSearchParams(window.location.search).get('workspace'));
  const match = channels.find((channel) => channel.id === wanted);
  return (match ?? channels.find((channel) => channel.items.length > 0) ?? channels[0])?.id ?? null;
}

export default function QueuePage() {
  const [phase, setPhase] = useState<Phase>('waiting-for-telegram');
  const [message, setMessage] = useState<string | null>(null);
  const [data, setData] = useState<QueueResponse | null>(null);
  const [channelId, setChannelId] = useState<number | null>(null);
  const [cards, setCards] = useState<Record<number, CardState>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  /** Started from the Telegram script's ready callback, as in the other pages. */
  const load = useCallback(async () => {
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

    setPhase('loading');
    try {
      const response = await fetch('/api/telegram/webapp/queue', {
        headers: { Authorization: `tma ${app.initData}` },
      });
      const body = (await response.json()) as QueueResponse & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);

      setData(body);
      setChannelId(channelFromLocation(body.channels));
      setPhase('ready');
    } catch (error: unknown) {
      setPhase('error');
      setMessage(error instanceof Error ? error.message : 'Could not load the queue.');
    }
  }, []);

  const setCard = (id: number, state: CardState) => setCards((all) => ({ ...all, [id]: state }));
  const setError = (id: number, error: string | null) =>
    setErrors((all) => {
      const next = { ...all };
      if (error) next[id] = error;
      else delete next[id];
      return next;
    });

  /** Approve or reject one post; the card settles in place, so the list does not jump. */
  const decide = useCallback(
    async (item: QueueItem, decision: { action: 'approve' } | { action: 'reject'; reason: string; note?: string }) => {
      const app = window.Telegram?.WebApp;
      if (!app) return;

      setCard(item.id, { kind: 'sending', what: decision.action });
      setError(item.id, null);
      try {
        const response = await fetch('/api/telegram/webapp/queue', {
          method: 'POST',
          headers: { Authorization: `tma ${app.initData}`, 'content-type': 'application/json' },
          body: JSON.stringify({ postId: item.id, ...decision }),
        });
        const body = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);

        const reason = decision.action === 'reject'
          ? data?.reasons.find((option) => option.value === decision.reason)?.label
          : null;
        setCard(item.id, {
          kind: 'done',
          outcome: decision.action === 'approve' ? '✅ Published' : `🚫 Rejected${reason ? ` · ${reason}` : ''}`,
        });
      } catch (error: unknown) {
        setCard(item.id, { kind: 'open' });
        setError(item.id, error instanceof Error ? error.message : 'Something went wrong.');
      }
    },
    [data],
  );

  const channel = data?.channels.find((candidate) => candidate.id === channelId) ?? null;
  const settled = channel ? channel.items.filter((item) => cards[item.id]?.kind === 'done').length : 0;

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
          maxWidth: '40rem',
          margin: '0 auto',
        }}
      >
        {phase === 'waiting-for-telegram' || phase === 'loading' ? (
          <p style={{ color: theme.hint }}>Loading…</p>
        ) : null}

        {phase === 'error' ? <p style={{ color: theme.hint }}>{message}</p> : null}

        {phase === 'ready' && data ? (
          <>
            <h1 style={{ fontSize: '1.05rem', fontWeight: 600, margin: '0 0 0.25rem' }}>Review queue</h1>

            {data.channels.length > 1 ? (
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', margin: '0.5rem 0' }}>
                {data.channels.map((candidate) => {
                  const active = candidate.id === channelId;
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      onClick={() => setChannelId(candidate.id)}
                      style={{
                        ...smallButton,
                        border: 'none',
                        background: active ? theme.button : theme.secondaryBg,
                        color: active ? theme.buttonText : theme.text,
                        fontWeight: active ? 600 : 400,
                      }}
                    >
                      📢 {candidate.name} · {candidate.waiting}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {channel ? (
              <p style={{ color: theme.hint, fontSize: '0.85rem', margin: '0 0 0.9rem' }}>
                {channel.waiting === 0
                  ? 'Nothing waiting. New posts will be announced in the chat.'
                  : `${channel.waiting - settled} waiting · best Radar score first` +
                    (channel.waiting > channel.items.length ? ` · showing the newest ${channel.items.length}` : '')}
              </p>
            ) : null}

            {channel?.items.map((item) => {
              const state = cards[item.id] ?? { kind: 'open' };
              const error = errors[item.id];
              const fullShown = expanded.has(item.id);
              const body = fullShown ? (item.fullText ?? item.text) : item.text;
              const long = body.length > PREVIEW_CHARS || Boolean(item.fullText);
              const shownText = fullShown || !long ? body : `${body.slice(0, PREVIEW_CHARS).trimEnd()}…`;
              const firstImage = item.media.find((media) => media.imageUrl);
              const busy = state.kind === 'sending';

              if (state.kind === 'done') {
                return (
                  <section
                    key={item.id}
                    style={{
                      background: theme.secondaryBg,
                      borderRadius: '0.6rem',
                      padding: '0.6rem 0.9rem',
                      marginBottom: '0.75rem',
                      opacity: 0.7,
                      fontSize: '0.9rem',
                    }}
                  >
                    {state.outcome} · {item.sourceLabel ?? 'unknown source'}
                  </section>
                );
              }

              return (
                <section
                  key={item.id}
                  style={{
                    background: theme.secondaryBg,
                    borderRadius: '0.6rem',
                    padding: '0.75rem 0.9rem',
                    marginBottom: '0.9rem',
                    opacity: busy ? 0.7 : 1,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    {item.score ? (
                      <span
                        style={{
                          minWidth: '2.2rem',
                          textAlign: 'center',
                          padding: '0.15rem 0.4rem',
                          borderRadius: '0.4rem',
                          background: scoreColour(item.score.score),
                          color: '#ffffff',
                          fontWeight: 700,
                          fontSize: '0.9rem',
                        }}
                        title="Radar score"
                      >
                        {item.score.score}
                      </span>
                    ) : (
                      <span style={{ color: theme.hint, fontSize: '0.8rem' }} title="No Radar score">
                        —
                      </span>
                    )}
                    <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                      {item.sourceLabel ?? 'unknown source'}
                      {item.platform === 'rss' ? <RssBadge /> : null}
                    </span>
                    <span style={{ color: theme.hint, fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                      {ago(item.postedAt)}
                    </span>
                  </div>

                  {firstImage?.imageUrl ? (
                    <div style={{ position: 'relative', marginBottom: '0.5rem' }}>
                      {/* X's own picture of the post; nothing of ours to optimise. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={firstImage.imageUrl}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        style={{
                          display: 'block',
                          width: '100%',
                          maxHeight: '18rem',
                          objectFit: 'cover',
                          borderRadius: '0.45rem',
                          background: theme.bg,
                        }}
                      />
                      {firstImage.kind === 'video' ? (
                        <span style={overlayBadge({ left: '0.5rem' })}>▶ video</span>
                      ) : null}
                      {item.media.length > 1 ? (
                        <span style={overlayBadge({ right: '0.5rem' })}>1 / {item.media.length}</span>
                      ) : null}
                    </div>
                  ) : item.media.length > 0 ? (
                    <div style={{ color: theme.hint, fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                      {item.media.length} media item{item.media.length === 1 ? '' : 's'} (no preview)
                    </div>
                  ) : null}

                  {shownText ? (
                    <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '0.92rem', lineHeight: 1.4 }}>
                      {shownText}
                    </div>
                  ) : (
                    <div style={{ color: theme.hint, fontSize: '0.85rem' }}>(no text)</div>
                  )}
                  {long ? (
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((all) => {
                          const next = new Set(all);
                          if (next.has(item.id)) next.delete(item.id);
                          else next.add(item.id);
                          return next;
                        })
                      }
                      style={{ ...smallButton, border: 'none', padding: '0.25rem 0', color: theme.link }}
                    >
                      {fullShown ? 'Less' : item.fullText ? 'Full text (sent as a second message)' : 'More'}
                    </button>
                  ) : null}
                  {item.edited ? (
                    <div style={{ color: theme.hint, fontSize: '0.75rem', marginTop: '0.2rem' }}>✏️ edited</div>
                  ) : null}

                  {item.score?.reason || item.score?.possiblyAlreadyCovered ? (
                    <div style={{ color: theme.hint, fontSize: '0.8rem', marginTop: '0.45rem', lineHeight: 1.35 }}>
                      📡 {item.score.predictedDecision === 'approve' ? 'likely approve' : 'likely reject'}
                      {item.score.possiblyAlreadyCovered ? ' · ♻️ may already be covered' : ''}
                      {item.score.reason ? ` — ${item.score.reason}` : ''}
                    </div>
                  ) : null}

                  <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.6rem' }}>
                    {item.url ? (
                      <button
                        type="button"
                        onClick={() => {
                          const app = window.Telegram?.WebApp;
                          if (app?.openLink) app.openLink(item.url);
                          else window.open(item.url, '_blank', 'noopener');
                        }}
                        style={smallButton}
                      >
                        Original ↗
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => window.location.assign(fromQueue(`/review?post=${item.id}`, channel.id))}
                      style={smallButton}
                    >
                      ✏️ Edit text
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => window.location.assign(fromQueue(`/review/schedule?post=${item.id}`, channel.id))}
                      style={smallButton}
                    >
                      🕒 Schedule
                    </button>
                  </div>

                  {state.kind === 'choosing-reason' || state.kind === 'writing-note' ? (
                    <div style={{ marginTop: '0.6rem' }}>
                      <div style={{ fontSize: '0.85rem', marginBottom: '0.35rem' }}>Why does it not fit?</div>
                      {state.kind === 'choosing-reason' ? (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
                          {data.reasons.map((reason) => (
                            <button
                              key={reason.value}
                              type="button"
                              onClick={() => {
                                if (reason.value === 'other') setCard(item.id, { kind: 'writing-note', note: '' });
                                else void decide(item, { action: 'reject', reason: reason.value });
                              }}
                              style={{ ...smallButton, fontSize: '0.85rem', padding: '0.5rem 0.4rem' }}
                            >
                              {reason.label}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <>
                          <textarea
                            value={state.note}
                            maxLength={data.noteLimit}
                            placeholder="In your own words (optional)"
                            onChange={(event) => setCard(item.id, { kind: 'writing-note', note: event.target.value })}
                            rows={3}
                            style={{
                              width: '100%',
                              boxSizing: 'border-box',
                              padding: '0.5rem',
                              borderRadius: '0.5rem',
                              border: `1px solid ${theme.hint}`,
                              background: theme.bg,
                              color: theme.text,
                              fontSize: '0.9rem',
                              fontFamily: 'inherit',
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => {
                              void decide(item, { action: 'reject', reason: 'other', note: state.note });
                            }}
                            style={{ ...button, width: '100%', marginTop: '0.4rem', background: '#e53935', color: '#ffffff' }}
                          >
                            Reject
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => setCard(item.id, { kind: 'open' })}
                        style={{ ...smallButton, border: 'none', marginTop: '0.3rem', color: theme.link }}
                      >
                        ↩️ Back
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem' }}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          void (async () => {
                            const where = channel.name ? ` to ${channel.name}` : '';
                            if (await confirmFirst(`Publish this post${where} now?`)) await decide(item, { action: 'approve' });
                          })();
                        }}
                        style={{ ...button, background: theme.button, color: theme.buttonText }}
                      >
                        {state.kind === 'sending' && state.what === 'approve' ? 'Publishing…' : '✅ Approve'}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setCard(item.id, { kind: 'choosing-reason' })}
                        style={{ ...button, background: theme.bg, color: theme.text }}
                      >
                        {state.kind === 'sending' && state.what === 'reject' ? 'Rejecting…' : '🚫 Reject'}
                      </button>
                    </div>
                  )}

                  {error ? (
                    <p style={{ color: '#e53935', fontSize: '0.85rem', margin: '0.5rem 0 0' }}>{error}</p>
                  ) : null}
                </section>
              );
            })}
          </>
        ) : null}
      </main>
    </>
  );
}

/** A small label laid over the corner of a picture. */
function overlayBadge(position: { left?: string; right?: string }) {
  return {
    position: 'absolute',
    bottom: '0.5rem',
    ...position,
    padding: '0.1rem 0.45rem',
    borderRadius: '0.35rem',
    background: 'rgba(0, 0, 0, 0.6)',
    color: '#ffffff',
    fontSize: '0.75rem',
  } as const;
}
