'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { RssBadge } from '@/app/(app)/rss-badge';
import { readJson, type PanelTools } from '@/components/panel-tools';
import { fromQueue, theme } from '@/lib/telegram/webapp-client';

/**
 * The review queue, for the Mini App and the website alike: every post
 * awaiting a decision in the reviewer's workspaces, best Radar score first —
 * Radar orders the list, it never leaves anything off it. Approve publishes
 * there and then; Reject asks why, with the same reasons as the chat.
 *
 * The two differ only in their frame. Each hands in `request`, which proves
 * who is asking its own way — the Mini App's signed `initData`, the website's
 * session cookie — and the server alone decides which posts are theirs. In
 * the Mini App, Edit and Schedule open their own pages and come back; on the
 * website they open in place, and the keyboard works the list.
 */

export interface QueueItem {
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

export interface ReviewQueueProps extends PanelTools {
  surface: 'mini-app' | 'website';
  /** The workspace to open on, when it is one of theirs. */
  initialWorkspaceId: number | null;
}

/** Where one card is: undecided, picking a reason, editing, on its way, or settled. */
type CardState =
  | { kind: 'open' }
  | { kind: 'choosing-reason' }
  | { kind: 'writing-note'; note: string }
  | { kind: 'editing' }
  | { kind: 'scheduling' }
  | { kind: 'sending'; what: 'approve' | 'reject' }
  | { kind: 'done'; outcome: string };

/** Characters of text a card shows before "More". */
const PREVIEW_CHARS = 420;

const button = {
  flex: 1,
  padding: '0.6rem 0',
  border: 'none',
  borderRadius: '0.55rem',
  fontSize: '0.95rem',
  fontWeight: 600,
  cursor: 'pointer',
} as const;

const smallButton = {
  padding: '0.4rem 0.6rem',
  border: `1px solid ${theme.hint}`,
  borderRadius: '0.5rem',
  background: 'transparent',
  color: theme.text,
  fontSize: '0.8rem',
  cursor: 'pointer',
} as const;

const fieldStyle = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.5rem',
  borderRadius: '0.5rem',
  border: `1px solid ${theme.hint}`,
  background: theme.bg,
  color: theme.text,
  fontSize: '0.9rem',
  fontFamily: 'inherit',
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

export function ReviewQueue({ surface, request, initialWorkspaceId, confirm, openLink }: ReviewQueueProps) {
  const [data, setData] = useState<QueueResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<number | null>(null);
  const [cards, setCards] = useState<Record<number, CardState>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  /** The card the keyboard acts on, on the website. */
  const [focused, setFocused] = useState<number | null>(null);
  const website = surface === 'website';

  useEffect(() => {
    let cancelled = false;
    request('/api/telegram/webapp/queue')
      .then((response) => readJson<QueueResponse>(response))
      .then((body) => {
        if (cancelled) return;
        setData(body);
        const match = body.channels.find((channel) => channel.id === initialWorkspaceId);
        setChannelId((match ?? body.channels.find((channel) => channel.items.length > 0) ?? body.channels[0])?.id ?? null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Could not load the queue.');
      });
    return () => {
      cancelled = true;
    };
  }, [request, initialWorkspaceId]);

  const setCard = useCallback((id: number, state: CardState) => setCards((all) => ({ ...all, [id]: state })), []);
  const setError = useCallback(
    (id: number, error: string | null) =>
      setErrors((all) => {
        const next = { ...all };
        if (error) next[id] = error;
        else delete next[id];
        return next;
      }),
    [],
  );
  const updateItem = useCallback(
    (id: number, change: Partial<QueueItem>) =>
      setData((current) =>
        current && {
          ...current,
          channels: current.channels.map((channel) => ({
            ...channel,
            items: channel.items.map((item) => (item.id === id ? { ...item, ...change } : item)),
          })),
        },
      ),
    [],
  );

  /** Approve or reject one post; the card settles in place, so the list does not jump. */
  const decide = useCallback(
    async (item: QueueItem, decision: { action: 'approve' } | { action: 'reject'; reason: string; note?: string }) => {
      setCard(item.id, { kind: 'sending', what: decision.action });
      setError(item.id, null);
      try {
        await readJson(
          await request('/api/telegram/webapp/queue', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ postId: item.id, ...decision }),
          }),
        );
        const reason =
          decision.action === 'reject' ? data?.reasons.find((option) => option.value === decision.reason)?.label : null;
        setCard(item.id, {
          kind: 'done',
          outcome: decision.action === 'approve' ? '✅ Published' : `🚫 Rejected${reason ? ` · ${reason}` : ''}`,
        });
      } catch (error: unknown) {
        setCard(item.id, { kind: 'open' });
        setError(item.id, error instanceof Error ? error.message : 'Something went wrong.');
      }
    },
    [data, request, setCard, setError],
  );

  const channel = data?.channels.find((candidate) => candidate.id === channelId) ?? null;

  const approve = useCallback(
    async (item: QueueItem) => {
      const where = channel?.name ? ` to ${channel.name}` : '';
      if (await confirm(`Publish this post${where} now?`)) await decide(item, { action: 'approve' });
    },
    [channel, confirm, decide],
  );

  const edit = useCallback(
    (item: QueueItem) => {
      if (website) setCard(item.id, { kind: 'editing' });
      else if (channel) window.location.assign(fromQueue(`/review?post=${item.id}`, channel.id));
    },
    [channel, setCard, website],
  );
  const schedule = useCallback(
    (item: QueueItem) => {
      if (website) setCard(item.id, { kind: 'scheduling' });
      else if (channel) window.location.assign(fromQueue(`/review/schedule?post=${item.id}`, channel.id));
    },
    [channel, setCard, website],
  );

  // The website's keyboard: j / k to move, a to approve, r then 1–6 to reject,
  // e to edit, s to schedule, o for the original, Esc to step back.
  const open = channel?.items.filter((item) => cards[item.id]?.kind !== 'done') ?? [];
  const active = website ? activeCard(channel?.items ?? [], cards, focused) : null;
  const latest = { open, active, cards, data, approve, decide, edit, schedule, openLink, setCard };
  const keyboard = useRef(latest);
  useEffect(() => {
    keyboard.current = latest;
  });

  useEffect(() => {
    if (!website) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
        if (event.key === 'Escape') target.blur();
        return;
      }
      const state = keyboard.current;
      const index = state.open.findIndex((item) => item.id === state.active);
      const item = index >= 0 ? state.open[index] : undefined;
      const move = (next: number) => {
        const target = state.open[Math.max(0, Math.min(state.open.length - 1, next))];
        if (!target) return;
        setFocused(target.id);
        document.getElementById(`post-${target.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      };

      if (event.key === 'j') return move(index + 1);
      if (event.key === 'k') return move(index <= 0 ? 0 : index - 1);
      if (!item) return;
      const cardState = state.cards[item.id]?.kind ?? 'open';
      if (cardState === 'sending') return;

      if (cardState === 'choosing-reason' && /^[1-9]$/.test(event.key)) {
        const reason = state.data?.reasons[Number(event.key) - 1];
        if (!reason) return;
        if (reason.value === 'other') state.setCard(item.id, { kind: 'writing-note', note: '' });
        else void state.decide(item, { action: 'reject', reason: reason.value });
        return;
      }
      if (event.key === 'Escape') return state.setCard(item.id, { kind: 'open' });
      if (cardState !== 'open') return;
      if (event.key === 'a') void state.approve(item);
      else if (event.key === 'r') state.setCard(item.id, { kind: 'choosing-reason' });
      else if (event.key === 'e') state.edit(item);
      else if (event.key === 's') state.schedule(item);
      else if (event.key === 'o' && item.url) state.openLink(item.url);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [website]);

  if (loadError) return <p style={{ color: theme.hint }}>{loadError}</p>;
  if (!data) return <p style={{ color: theme.hint }}>Loading…</p>;

  const settled = channel ? channel.items.filter((item) => cards[item.id]?.kind === 'done').length : 0;

  return (
    <>
      {data.channels.length > 1 ? (
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', margin: '0.5rem 0' }}>
          {data.channels.map((candidate) => {
            const active = candidate.id === channelId;
            return (
              <button
                key={candidate.id}
                type="button"
                onClick={() => {
                  setChannelId(candidate.id);
                  setFocused(null);
                }}
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
          {website && channel.waiting > 0 ? (
            <span style={{ display: 'block', fontSize: '0.75rem', marginTop: '0.2rem' }}>
              Keys: j / k move · a approve · r reject, then 1–6 · e edit · s schedule · o original · Esc back
            </span>
          ) : null}
        </p>
      ) : null}

      {channel?.items.map((item) => {
        const state = cards[item.id] ?? { kind: 'open' };
        const error = errors[item.id];

        if (state.kind === 'done') {
          return (
            <section
              key={item.id}
              id={`post-${item.id}`}
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

        const fullShown = expanded.has(item.id);
        const body = fullShown ? (item.fullText ?? item.text) : item.text;
        const long = body.length > PREVIEW_CHARS || Boolean(item.fullText);
        const shownText = fullShown || !long ? body : `${body.slice(0, PREVIEW_CHARS).trimEnd()}…`;
        const busy = state.kind === 'sending';
        const isFocused = active === item.id;

        return (
          <section
            key={item.id}
            id={`post-${item.id}`}
            onClick={website ? () => setFocused(item.id) : undefined}
            style={{
              background: theme.secondaryBg,
              borderRadius: '0.6rem',
              padding: '0.75rem 0.9rem',
              marginBottom: '0.9rem',
              opacity: busy ? 0.7 : 1,
              outline: isFocused ? `2px solid ${theme.button}` : 'none',
              outlineOffset: '2px',
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
              <span style={{ color: theme.hint, fontSize: '0.8rem', whiteSpace: 'nowrap' }}>{ago(item.postedAt)}</span>
            </div>

            {/* Side by side where there is room, picture over text where there is not. */}
            <div
              style={
                website
                  ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 20rem), 1fr))', gap: '0.9rem' }
                  : undefined
              }
            >
              <MediaGallery media={item.media} />

              <div>
                {state.kind === 'editing' ? (
                  <CaptionEditor
                    postId={item.id}
                    request={request}
                    onDone={(saved) => {
                      if (saved !== null) updateItem(item.id, { text: saved, fullText: null, edited: true });
                      setCard(item.id, { kind: 'open' });
                    }}
                  />
                ) : (
                  <>
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
                  </>
                )}

                {item.score?.reason || item.score?.possiblyAlreadyCovered ? (
                  <div style={{ color: theme.hint, fontSize: '0.8rem', marginTop: '0.45rem', lineHeight: 1.35 }}>
                    📡 {item.score.predictedDecision === 'approve' ? 'likely approve' : 'likely reject'}
                    {item.score.possiblyAlreadyCovered ? ' · ♻️ may already be covered' : ''}
                    {item.score.reason ? ` — ${item.score.reason}` : ''}
                  </div>
                ) : null}

                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.6rem' }}>
                  {item.url ? (
                    <button type="button" onClick={() => openLink(item.url)} style={smallButton}>
                      Original ↗
                    </button>
                  ) : null}
                  <button type="button" disabled={busy || state.kind === 'editing'} onClick={() => edit(item)} style={smallButton}>
                    ✏️ Edit text
                  </button>
                  <button
                    type="button"
                    disabled={busy || state.kind === 'scheduling'}
                    onClick={() => schedule(item)}
                    style={smallButton}
                  >
                    🕒 Schedule
                  </button>
                </div>

                {state.kind === 'scheduling' ? (
                  <ScheduleEditor
                    postId={item.id}
                    request={request}
                    onCancel={() => setCard(item.id, { kind: 'open' })}
                    onScheduled={(display) => setCard(item.id, { kind: 'done', outcome: `🕒 Scheduled for ${display}` })}
                  />
                ) : null}

                {state.kind === 'choosing-reason' || state.kind === 'writing-note' ? (
                  <div style={{ marginTop: '0.6rem' }}>
                    <div style={{ fontSize: '0.85rem', marginBottom: '0.35rem' }}>Why does it not fit?</div>
                    {state.kind === 'choosing-reason' ? (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
                        {data.reasons.map((reason, index) => (
                          <button
                            key={reason.value}
                            type="button"
                            onClick={() => {
                              if (reason.value === 'other') setCard(item.id, { kind: 'writing-note', note: '' });
                              else void decide(item, { action: 'reject', reason: reason.value });
                            }}
                            style={{ ...smallButton, fontSize: '0.85rem', padding: '0.5rem 0.4rem' }}
                          >
                            {website ? `${index + 1} · ` : ''}
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
                          autoFocus={website}
                          onChange={(event) => setCard(item.id, { kind: 'writing-note', note: event.target.value })}
                          rows={3}
                          style={fieldStyle}
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
                ) : state.kind === 'editing' || state.kind === 'scheduling' ? null : (
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem' }}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        void approve(item);
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

                {error ? <p style={{ color: '#e53935', fontSize: '0.85rem', margin: '0.5rem 0 0' }}>{error}</p> : null}
              </div>
            </div>
          </section>
        );
      })}
    </>
  );
}

/**
 * The post the keyboard acts on: the one picked, or — once it is decided —
 * the next one still open, so a decision moves on to the following post.
 * The first post has the keyboard until another is picked.
 */
function activeCard(items: QueueItem[], cards: Record<number, CardState>, focused: number | null): number | null {
  const undecided = (item: QueueItem) => cards[item.id]?.kind !== 'done';
  const at = items.findIndex((item) => item.id === focused);
  if (at === -1) return items.find(undecided)?.id ?? null;
  return (items.slice(at).find(undecided) ?? items.slice(0, at).reverse().find(undecided))?.id ?? null;
}

/**
 * The text of one post, edited in place on the website — the same endpoint
 * as the Mini App's editor, and the same rules: the channel's footer is shown
 * under the box, not in it, and the limit is what Telegram allows.
 */
function CaptionEditor({
  postId,
  request,
  onDone,
}: {
  postId: number;
  request: ReviewQueueProps['request'];
  /** The saved text, or null when nothing was saved. */
  onDone: (saved: string | null) => void;
}) {
  const [details, setDetails] = useState<{ caption: string; footer: string | null; limit: number } | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    request(`/api/telegram/webapp/caption?post=${postId}`)
      .then((response) => readJson<{ caption: string; footer: string | null; limit: number }>(response))
      .then((body) => {
        if (cancelled) return;
        setDetails(body);
        setText(body.caption);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not load the text.');
      });
    return () => {
      cancelled = true;
    };
  }, [postId, request]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = await readJson<{ caption: string }>(
        await request('/api/telegram/webapp/caption', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ postId, caption: text }),
        }),
      );
      onDone(body.caption);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not save.');
      setSaving(false);
    }
  };

  if (!details) {
    return error ? <p style={{ color: '#e53935', fontSize: '0.85rem' }}>{error}</p> : <p style={{ color: theme.hint }}>Loading…</p>;
  }

  const length = text.trim().length;
  const tooLong = length > details.limit;
  return (
    <div>
      <textarea
        value={text}
        autoFocus
        onChange={(event) => setText(event.target.value)}
        rows={10}
        style={{ ...fieldStyle, resize: 'vertical' }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: tooLong ? '#e53935' : theme.hint }}>
        <span>{details.footer ? `+ footer: ${details.footer}` : ''}</span>
        <span>
          {length} / {details.limit}
        </span>
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem' }}>
        <button
          type="button"
          disabled={saving || tooLong || length === 0}
          onClick={() => {
            void save();
          }}
          style={{ ...button, background: theme.button, color: theme.buttonText, opacity: saving || tooLong || length === 0 ? 0.6 : 1 }}
        >
          {saving ? 'Saving…' : 'Save text'}
        </button>
        <button type="button" disabled={saving} onClick={() => onDone(null)} style={{ ...button, background: theme.bg, color: theme.text }}>
          Cancel
        </button>
      </div>
      {error ? <p style={{ color: '#e53935', fontSize: '0.85rem', margin: '0.4rem 0 0' }}>{error}</p> : null}
    </div>
  );
}

/** A local `datetime-local` value for a moment: what the picker shows, in this browser's zone. */
function localInputValue(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Approve a post for later, on the website: a time in this browser's zone, sent as an exact moment. */
function ScheduleEditor({
  postId,
  request,
  onCancel,
  onScheduled,
}: {
  postId: number;
  request: ReviewQueueProps['request'];
  onCancel: () => void;
  onScheduled: (display: string) => void;
}) {
  const [value, setValue] = useState(() => {
    const next = new Date(Date.now() + 60 * 60 * 1000);
    next.setMinutes(0, 0, 0);
    return localInputValue(next);
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) return setError('Pick a date and time.');
    setSaving(true);
    setError(null);
    try {
      const body = await readJson<{ display: string }>(
        await request('/api/telegram/webapp/schedule', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            postId,
            scheduledFor: at.toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        }),
      );
      onScheduled(body.display);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not schedule.');
      setSaving(false);
    }
  };

  return (
    <div style={{ marginTop: '0.6rem' }}>
      <div style={{ fontSize: '0.85rem', marginBottom: '0.35rem' }}>Publish at</div>
      <input
        type="datetime-local"
        value={value}
        autoFocus
        onChange={(event) => setValue(event.target.value)}
        style={fieldStyle}
      />
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem' }}>
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            void submit();
          }}
          style={{ ...button, background: theme.button, color: theme.buttonText }}
        >
          {saving ? 'Scheduling…' : '🕒 Schedule'}
        </button>
        <button type="button" disabled={saving} onClick={onCancel} style={{ ...button, background: theme.bg, color: theme.text }}>
          Cancel
        </button>
      </div>
      {error ? <p style={{ color: '#e53935', fontSize: '0.85rem', margin: '0.4rem 0 0' }}>{error}</p> : null}
    </div>
  );
}

/**
 * Every picture of a post, side by side: swiped on a phone, stepped through
 * with the arrows elsewhere. A photo is shown whole rather than cropped, as it
 * will be in the channel; a video by its still.
 */
function MediaGallery({ media }: { media: QueueItem['media'] }) {
  const strip = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);

  if (media.length === 0) return null;
  if (!media.some((item) => item.imageUrl)) {
    return (
      <div style={{ color: theme.hint, fontSize: '0.8rem', marginBottom: '0.5rem' }}>
        {media.length} media item{media.length === 1 ? '' : 's'} (no preview)
      </div>
    );
  }

  const go = (next: number) => {
    const element = strip.current;
    if (!element) return;
    element.scrollTo({ left: next * element.clientWidth, behavior: 'smooth' });
  };
  const current = media[index];

  return (
    <div style={{ position: 'relative', marginBottom: '0.5rem' }}>
      <div
        ref={strip}
        onScroll={(event) => {
          const element = event.currentTarget;
          setIndex(Math.min(media.length - 1, Math.max(0, Math.round(element.scrollLeft / element.clientWidth))));
        }}
        style={{
          display: 'flex',
          overflowX: 'auto',
          scrollSnapType: 'x mandatory',
          scrollbarWidth: 'none',
          borderRadius: '0.45rem',
          background: '#111111',
        }}
      >
        {media.map((item, position) => (
          <div
            key={position}
            style={{
              flex: '0 0 100%',
              height: '18rem',
              scrollSnapAlign: 'center',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {item.imageUrl ? (
              // X's own picture of the post; nothing of ours to optimise.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.imageUrl}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain' }}
              />
            ) : (
              <span style={{ color: '#bbbbbb', fontSize: '0.85rem' }}>
                {item.kind === 'video' ? '▶ video, no preview' : 'no preview'}
              </span>
            )}
          </div>
        ))}
      </div>

      {current?.kind === 'video' && current.imageUrl ? <span style={overlayBadge({ left: '0.5rem' })}>▶ video</span> : null}
      {media.length > 1 ? (
        <>
          <span style={overlayBadge({ right: '0.5rem' })}>
            {index + 1} / {media.length}
          </span>
          {index > 0 ? (
            <button type="button" aria-label="Previous" onClick={() => go(index - 1)} style={arrowButton('left')}>
              ‹
            </button>
          ) : null}
          {index < media.length - 1 ? (
            <button type="button" aria-label="Next" onClick={() => go(index + 1)} style={arrowButton('right')}>
              ›
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** A round arrow on one side of the gallery. */
function arrowButton(side: 'left' | 'right'): CSSProperties {
  return {
    position: 'absolute',
    top: '50%',
    [side]: '0.4rem',
    transform: 'translateY(-50%)',
    width: '2rem',
    height: '2rem',
    border: 'none',
    borderRadius: '50%',
    background: 'rgba(0, 0, 0, 0.55)',
    color: '#ffffff',
    fontSize: '1.3rem',
    lineHeight: 1,
    padding: 0,
    cursor: 'pointer',
  };
}

/** A small label laid over the corner of a picture. */
function overlayBadge(position: { left?: string; right?: string }): CSSProperties {
  return {
    position: 'absolute',
    bottom: '0.5rem',
    ...position,
    padding: '0.1rem 0.45rem',
    borderRadius: '0.35rem',
    background: 'rgba(0, 0, 0, 0.6)',
    color: '#ffffff',
    fontSize: '0.75rem',
  };
}
