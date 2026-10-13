'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { PlatformBadge } from '@/app/(app)/platform-badge';
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
  platform: 'x' | 'rss' | 'telegram' | 'youtube';
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
  /** A post its source sent before: when the earlier copy came, and what became of it. */
  repeat: { arrivedAt: string; outcome: string } | null;
  edited: boolean;
  /** Written in the website's editor: goes out as a rich message. */
  rich: boolean;
  /** The other waiting posts of its story: one card, decided together. */
  alsoInStory: QueueItem[];
  /** What of its story the channel has already published or scheduled. */
  storyPublished: { sourceLabel: string | null; approvedAt: string }[];
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
  /** The post whose card to open at — a digest's story — when it is still waiting. */
  initialPostId?: number | null;
  /** Open a post in the frame's editor; without it, the Mini App's caption editor. */
  onEdit?: (postId: number, workspaceId: number) => void;
}

/** Where one card is: undecided, picking a reason, editing, on its way, or settled. */
type CardState =
  | { kind: 'open' }
  | { kind: 'choosing-reason' }
  | { kind: 'writing-note'; note: string }
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

/** A post its source sent before, and what became of the earlier copy: `🔁 Repeat of 10 Oct · rejected`. */
function RepeatBadge({ repeat }: { repeat: NonNullable<QueueItem['repeat']> }) {
  const day = new Date(repeat.arrivedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return (
    <span
      title={`The same post as one this source sent on ${day}, which was ${repeat.outcome}`}
      style={{
        marginLeft: '0.4rem',
        padding: '0.05rem 0.4rem',
        borderRadius: '0.3rem',
        background: '#7a5af5',
        color: '#ffffff',
        fontSize: '0.7rem',
        fontWeight: 700,
        verticalAlign: 'middle',
        whiteSpace: 'nowrap',
      }}
    >
      🔁 Repeat of {day} · {repeat.outcome}
    </span>
  );
}

/** What happened to the rest of a story's card, after the outcome of its post. */
function restOfStoryOutcome(action: 'approve' | 'reject', count: number): string {
  if (count === 0) return '';
  const posts = count === 1 ? '1 more of the story' : `${count} more of the story`;
  return action === 'approve' ? ` · ${posts} rejected as already covered` : ` · ${posts} too`;
}

/** "12 Oct", in this browser's zone. */
function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * The rest of a story on its card: what the channel already published of it,
 * and the other waiting posts — each can be put in the card's place, and all
 * are decided with it.
 */
function StoryPanel({
  card,
  others,
  onShow,
  openLink,
  disabled,
}: {
  card: QueueItem;
  others: QueueItem[];
  onShow: (post: QueueItem) => void;
  openLink: (url: string) => void;
  disabled: boolean;
}) {
  if (others.length === 0 && card.storyPublished.length === 0) return null;
  const published = card.storyPublished;

  return (
    <div
      style={{
        marginTop: '0.6rem',
        padding: '0.5rem 0.6rem',
        borderRadius: '0.45rem',
        border: `1px solid ${theme.hint}`,
        fontSize: '0.8rem',
      }}
    >
      {published.length > 0 ? (
        <div style={{ color: theme.hint, marginBottom: others.length > 0 ? '0.4rem' : 0 }}>
          📚 Already published from{' '}
          {published.map((entry) => `${entry.sourceLabel ?? 'unknown source'} · ${shortDay(entry.approvedAt)}`).join(', ')}
        </div>
      ) : null}
      {others.length > 0 ? (
        <>
          <div style={{ fontWeight: 600, marginBottom: '0.15rem' }}>
            📚 Same story · {others.length} more waiting
          </div>
          <div style={{ color: theme.hint, fontSize: '0.75rem', marginBottom: '0.35rem' }}>
            Approve publishes the post above and rejects {others.length === 1 ? 'this one' : 'these'} as already
            covered; Reject turns down the whole story.
          </div>
          {others.map((post) => (
            <div key={post.id} style={{ padding: '0.35rem 0', borderTop: `1px solid ${theme.secondaryBg}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                {post.score ? (
                  <span
                    style={{
                      padding: '0 0.3rem',
                      borderRadius: '0.3rem',
                      background: scoreColour(post.score.score),
                      color: '#ffffff',
                      fontWeight: 700,
                      fontSize: '0.75rem',
                    }}
                    title="Radar score"
                  >
                    {post.score.score}
                  </span>
                ) : null}
                <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
                  {post.sourceLabel ?? 'unknown source'}
                  <PlatformBadge platform={post.platform} />
                  {post.repeat ? <RepeatBadge repeat={post.repeat} /> : null}
                </span>
                <span style={{ color: theme.hint }}>{ago(post.postedAt)}</span>
              </div>
              <div style={{ margin: '0.2rem 0', overflowWrap: 'anywhere', lineHeight: 1.35 }}>
                {post.text.length > 160 ? `${post.text.slice(0, 160).trimEnd()}…` : post.text || '(no text)'}
              </div>
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                <button type="button" disabled={disabled} onClick={() => onShow(post)} style={smallButton}>
                  ⇅ Use this one
                </button>
                {post.url ? (
                  <button type="button" onClick={() => openLink(post.url)} style={smallButton}>
                    Original ↗
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

/** Green for a likely approval, amber for a maybe, grey for a likely no. */
function scoreColour(score: number): string {
  if (score >= 70) return '#2e9e4f';
  if (score >= 45) return '#d08a00';
  return '#8a8f94';
}

export function ReviewQueue({
  surface,
  request,
  initialWorkspaceId,
  initialPostId,
  confirm,
  openLink,
  onEdit,
}: ReviewQueueProps) {
  const [data, setData] = useState<QueueResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<number | null>(null);
  const [cards, setCards] = useState<Record<number, CardState>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  /** The card the keyboard acts on, on the website. */
  const [focused, setFocused] = useState<number | null>(null);
  /** The card a digest's link opened the page at: scrolled to, and marked. */
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  /** For a story's card, the post picked to publish in place of its best-scored one. */
  const [chosen, setChosen] = useState<Record<number, number>>({});
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
        // A digest's story: its card, wherever the post is on it.
        const card = (match ?? body.channels[0])?.items.find(
          (item) => item.id === initialPostId || item.alsoInStory.some((other) => other.id === initialPostId),
        );
        if (card) {
          setFocused(card.id);
          setOpenedAt(card.id);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Could not load the queue.');
      });
    return () => {
      cancelled = true;
    };
  }, [request, initialWorkspaceId, initialPostId]);

  useEffect(() => {
    if (openedAt !== null) document.getElementById(`post-${openedAt}`)?.scrollIntoView({ block: 'start' });
  }, [openedAt, data]);

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

  /** A card's post as it stands — the best-scored of its story, or the one picked — and the rest of the card. */
  const shown = useCallback(
    (card: QueueItem) => {
      const story = [card, ...card.alsoInStory];
      const item = story.find((post) => post.id === chosen[card.id]) ?? card;
      return { item, others: story.filter((post) => post.id !== item.id) };
    },
    [chosen],
  );

  /**
   * Approve or reject a card's post, and with it the rest of its story; the
   * card settles in place, so the list does not jump.
   */
  const decide = useCallback(
    async (card: QueueItem, decision: { action: 'approve' } | { action: 'reject'; reason: string; note?: string }) => {
      const { item, others } = shown(card);
      setCard(card.id, { kind: 'sending', what: decision.action });
      setError(card.id, null);
      try {
        const body = await readJson<{ alsoRejected?: number[] }>(
          await request('/api/telegram/webapp/queue', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              postId: item.id,
              ...decision,
              ...(others.length > 0 ? { alsoInStory: others.map((post) => post.id) } : {}),
            }),
          }),
        );
        const reason =
          decision.action === 'reject' ? data?.reasons.find((option) => option.value === decision.reason)?.label : null;
        setCard(card.id, {
          kind: 'done',
          outcome:
            (decision.action === 'approve' ? '✅ Published' : `🚫 Rejected${reason ? ` · ${reason}` : ''}`) +
            restOfStoryOutcome(decision.action, body.alsoRejected?.length ?? 0),
        });
      } catch (error: unknown) {
        setCard(card.id, { kind: 'open' });
        setError(card.id, error instanceof Error ? error.message : 'Something went wrong.');
      }
    },
    [data, request, setCard, setError, shown],
  );

  const channel = data?.channels.find((candidate) => candidate.id === channelId) ?? null;

  const approve = useCallback(
    async (card: QueueItem) => {
      const where = channel?.name ? ` to ${channel.name}` : '';
      const rest = shown(card).others.length;
      const also = rest > 0 ? ` The other ${rest === 1 ? 'post' : `${rest} posts`} of this story will be rejected as already covered.` : '';
      if (await confirm(`Publish this post${where} now?${also}`)) await decide(card, { action: 'approve' });
    },
    [channel, confirm, decide, shown],
  );

  const edit = useCallback(
    (card: QueueItem) => {
      if (!channel) return;
      const { item } = shown(card);
      if (onEdit) onEdit(item.id, channel.id);
      else window.location.assign(fromQueue(`/review?post=${item.id}`, channel.id));
    },
    [channel, onEdit, shown],
  );
  const schedule = useCallback(
    (card: QueueItem) => {
      if (website) setCard(card.id, { kind: 'scheduling' });
      else if (channel) window.location.assign(fromQueue(`/review/schedule?post=${shown(card).item.id}`, channel.id));
    },
    [channel, setCard, shown, website],
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

  // Counted in posts, as `waiting` is: a story's card settles all of its own.
  const settled = channel
    ? channel.items.filter((card) => cards[card.id]?.kind === 'done').reduce((total, card) => total + 1 + card.alsoInStory.length, 0)
    : 0;
  const loaded = channel ? channel.items.reduce((total, card) => total + 1 + card.alsoInStory.length, 0) : 0;

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
              (channel.waiting > loaded ? ` · showing the newest ${loaded}` : '') +
              (loaded > channel.items.length ? ` · one card per story` : '')}
          {website && channel.waiting > 0 ? (
            <span style={{ display: 'block', fontSize: '0.75rem', marginTop: '0.2rem' }}>
              Keys: j / k move · a approve · r reject, then 1–6 · e edit · s schedule · o original · Esc back
            </span>
          ) : null}
        </p>
      ) : null}

      {channel?.items.map((card) => {
        const { item, others } = shown(card);
        const state = cards[card.id] ?? { kind: 'open' };
        const error = errors[card.id];

        if (state.kind === 'done') {
          return (
            <section
              key={card.id}
              id={`post-${card.id}`}
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
        const isFocused = active === card.id || (!website && openedAt === card.id);

        return (
          <section
            key={card.id}
            id={`post-${card.id}`}
            onClick={website ? () => setFocused(card.id) : undefined}
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
                <PlatformBadge platform={item.platform} />
                {item.repeat ? <RepeatBadge repeat={item.repeat} /> : null}
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
                {item.rich ? (
                  <div style={{ color: theme.hint, fontSize: '0.75rem', marginTop: '0.2rem' }}>
                    📰 written in the editor — goes out as laid out there
                  </div>
                ) : item.edited ? (
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
                    <button type="button" onClick={() => openLink(item.url)} style={smallButton}>
                      Original ↗
                    </button>
                  ) : null}
                  <button type="button" disabled={busy} onClick={() => edit(card)} style={smallButton}>
                    ✏️ Edit text
                  </button>
                  <button
                    type="button"
                    disabled={busy || state.kind === 'scheduling'}
                    onClick={() => schedule(card)}
                    style={smallButton}
                  >
                    🕒 Schedule
                  </button>
                </div>

                <StoryPanel
                  card={card}
                  others={others}
                  onShow={(post) => setChosen((all) => ({ ...all, [card.id]: post.id }))}
                  openLink={openLink}
                  disabled={busy}
                />

                {state.kind === 'scheduling' ? (
                  <ScheduleEditor
                    postId={item.id}
                    alsoInStory={others.map((post) => post.id)}
                    request={request}
                    onCancel={() => setCard(card.id, { kind: 'open' })}
                    onScheduled={(display, alsoRejected) =>
                      setCard(card.id, {
                        kind: 'done',
                        outcome: `🕒 Scheduled for ${display}${restOfStoryOutcome('approve', alsoRejected)}`,
                      })
                    }
                  />
                ) : null}

                {state.kind === 'choosing-reason' || state.kind === 'writing-note' ? (
                  <div style={{ marginTop: '0.6rem' }}>
                    <div style={{ fontSize: '0.85rem', marginBottom: '0.35rem' }}>
                      Why does it not fit?{others.length > 0 ? ` — for all ${others.length + 1} posts of this story` : ''}
                    </div>
                    {state.kind === 'choosing-reason' ? (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
                        {data.reasons.map((reason, index) => (
                          <button
                            key={reason.value}
                            type="button"
                            onClick={() => {
                              if (reason.value === 'other') setCard(card.id, { kind: 'writing-note', note: '' });
                              else void decide(card, { action: 'reject', reason: reason.value });
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
                          onChange={(event) => setCard(card.id, { kind: 'writing-note', note: event.target.value })}
                          rows={3}
                          style={fieldStyle}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            void decide(card, { action: 'reject', reason: 'other', note: state.note });
                          }}
                          style={{ ...button, width: '100%', marginTop: '0.4rem', background: '#e53935', color: '#ffffff' }}
                        >
                          Reject
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => setCard(card.id, { kind: 'open' })}
                      style={{ ...smallButton, border: 'none', marginTop: '0.3rem', color: theme.link }}
                    >
                      ↩️ Back
                    </button>
                  </div>
                ) : state.kind === 'scheduling' ? null : (
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem' }}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        void approve(card);
                      }}
                      style={{ ...button, background: theme.button, color: theme.buttonText }}
                    >
                      {state.kind === 'sending' && state.what === 'approve' ? 'Publishing…' : '✅ Approve'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setCard(card.id, { kind: 'choosing-reason' })}
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

/** A local `datetime-local` value for a moment: what the picker shows, in this browser's zone. */
function localInputValue(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Approve a post for later, on the website: a time in this browser's zone, sent as an exact moment. */
function ScheduleEditor({
  postId,
  alsoInStory,
  request,
  onCancel,
  onScheduled,
}: {
  postId: number;
  /** The rest of its story's card, rejected as already covered once it is scheduled. */
  alsoInStory: number[];
  request: ReviewQueueProps['request'];
  onCancel: () => void;
  onScheduled: (display: string, alsoRejected: number) => void;
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
      const body = await readJson<{ display: string; alsoRejected?: number[] }>(
        await request('/api/telegram/webapp/schedule', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            postId,
            scheduledFor: at.toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            ...(alsoInStory.length > 0 ? { alsoInStory } : {}),
          }),
        }),
      );
      onScheduled(body.display, body.alsoRejected?.length ?? 0);
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
