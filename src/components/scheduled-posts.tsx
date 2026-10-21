'use client';

import { useCallback, useEffect, useState } from 'react';
import { PlatformBadge } from '@/app/(app)/platform-badge';
import { readJson, type PanelTools } from '@/components/panel-tools';
import { localInputValue, MediaGallery } from '@/components/review-queue';
import { theme } from '@/lib/telegram/webapp-client';

/**
 * The posts approved for a set time and not gone out yet, soonest first, by
 * day: each can be edited, moved to another time, or taken back into the
 * review queue. The scheduler reads a post's text and time only when the
 * time comes, so a change here up to that minute is what goes out.
 */

interface ScheduledItem {
  id: number;
  platform: 'x' | 'rss' | 'telegram' | 'youtube' | 'website';
  sourceLabel: string | null;
  url: string;
  text: string;
  media: { kind: 'photo' | 'video'; imageUrl: string | null }[];
  scheduledFor: string;
  display: string;
  edited: boolean;
  rich: boolean;
}

interface Channel {
  id: number;
  name: string;
  items: ScheduledItem[];
}

export interface ScheduledPostsProps extends PanelTools {
  /** Open a post in the frame's editor. */
  onEdit: (postId: number, workspaceId: number) => void;
}

/** Where one card is: shown, its time being changed, on its way back to the queue, or gone back. */
type CardState = { kind: 'open' } | { kind: 'retiming'; value: string } | { kind: 'saving' } | { kind: 'unscheduled' };

const PREVIEW_CHARS = 420;

const button = {
  flex: 1,
  padding: '0.55rem 0',
  border: 'none',
  borderRadius: '0.55rem',
  fontSize: '0.9rem',
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

/** "in 25m", "in 3h", "in 2d"; "any moment" once the time has come. */
function until(iso: string, now: number): string {
  const minutes = Math.round((new Date(iso).getTime() - now) / 60_000);
  if (minutes <= 0) return 'any moment';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** The day a post goes out, in this browser's zone: "Today", "Tomorrow", "Thu 16 Oct". */
function dayLabel(iso: string, now: number): string {
  const day = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const days = Math.round((day(new Date(iso)) - day(new Date(now))) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));
}

const localTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

const bySchedule = (a: ScheduledItem, b: ScheduledItem) =>
  a.scheduledFor.localeCompare(b.scheduledFor) || a.id - b.id;

export function ScheduledPosts({ request, confirm, openLink, onEdit }: ScheduledPostsProps) {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<number | null>(null);
  const [cards, setCards] = useState<Record<number, CardState>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  /** "Now" for the countdowns, moved on every minute rather than read during render. */
  const [now, setNow] = useState(0);

  useEffect(() => {
    let cancelled = false;
    request('/api/telegram/webapp/scheduled')
      .then((response) => readJson<{ channels: Channel[] }>(response))
      .then((body) => {
        if (cancelled) return;
        setNow(Date.now());
        setChannels(body.channels);
        setChannelId((body.channels.find((channel) => channel.items.length > 0) ?? body.channels[0])?.id ?? null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Could not load scheduled posts.');
      });
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      cancelled = true;
      clearInterval(tick);
    };
  }, [request]);

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

  /** Move a post to another time: the list re-sorts, so it lands among its new neighbours. */
  const retime = useCallback(
    async (item: ScheduledItem, value: string) => {
      const at = new Date(value);
      if (Number.isNaN(at.getTime())) return setError(item.id, 'Pick a date and time.');
      setCard(item.id, { kind: 'saving' });
      setError(item.id, null);
      try {
        const body = await readJson<{ scheduledFor: string; display: string }>(
          await request('/api/telegram/webapp/schedule', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              postId: item.id,
              scheduledFor: at.toISOString(),
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }),
          }),
        );
        setChannels((all) =>
          (all ?? []).map((channel) => ({
            ...channel,
            items: channel.items
              .map((post) => (post.id === item.id ? { ...post, scheduledFor: body.scheduledFor, display: body.display } : post))
              .sort(bySchedule),
          })),
        );
        setNow(Date.now());
        setCard(item.id, { kind: 'open' });
      } catch (error: unknown) {
        setCard(item.id, { kind: 'retiming', value });
        setError(item.id, error instanceof Error ? error.message : 'Could not change the time.');
      }
    },
    [request, setCard, setError],
  );

  const unschedule = useCallback(
    async (item: ScheduledItem) => {
      if (!(await confirm('Take this post off the schedule and back into the review queue?'))) return;
      setCard(item.id, { kind: 'saving' });
      setError(item.id, null);
      try {
        await readJson(
          await request('/api/telegram/webapp/scheduled', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'unschedule', postId: item.id }),
          }),
        );
        setCard(item.id, { kind: 'unscheduled' });
      } catch (error: unknown) {
        setCard(item.id, { kind: 'open' });
        setError(item.id, error instanceof Error ? error.message : 'Could not unschedule.');
      }
    },
    [confirm, request, setCard, setError],
  );

  if (loadError) return <p style={{ color: theme.hint }}>{loadError}</p>;
  if (!channels) return <p style={{ color: theme.hint }}>Loading…</p>;

  const channel = channels.find((candidate) => candidate.id === channelId) ?? null;
  const waiting = channel?.items.filter((item) => cards[item.id]?.kind !== 'unscheduled').length ?? 0;

  return (
    <>
      {channels.length > 1 ? (
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', margin: '0.5rem 0' }}>
          {channels.map((candidate) => {
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
                📢 {candidate.name} · {candidate.items.length}
              </button>
            );
          })}
        </div>
      ) : null}

      {channel ? (
        <p style={{ color: theme.hint, fontSize: '0.85rem', margin: '0 0 0.9rem' }}>
          {waiting === 0
            ? 'Nothing scheduled. Use 🕒 Schedule on a post in the review queue.'
            : `${waiting} scheduled · soonest first · the bot publishes each within a minute of its time`}
        </p>
      ) : null}

      {channel?.items.map((item, index) => {
        const state = cards[item.id] ?? { kind: 'open' };
        const error = errors[item.id];
        const day = dayLabel(item.scheduledFor, now);
        const newDay = index === 0 || dayLabel(channel.items[index - 1]!.scheduledFor, now) !== day;
        const heading = newDay ? (
          <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: theme.hint, margin: '1.1rem 0 0.5rem' }}>{day}</h2>
        ) : null;

        if (state.kind === 'unscheduled') {
          return (
            <div key={item.id}>
              {heading}
              <section
                style={{
                  background: theme.secondaryBg,
                  borderRadius: '0.6rem',
                  padding: '0.6rem 0.9rem',
                  marginBottom: '0.75rem',
                  opacity: 0.7,
                  fontSize: '0.9rem',
                }}
              >
                ↩️ Back in the review queue · {item.sourceLabel ?? 'unknown source'}
              </section>
            </div>
          );
        }

        const busy = state.kind === 'saving';
        const fullShown = expanded.has(item.id);
        const long = item.text.length > PREVIEW_CHARS;
        const shownText = fullShown || !long ? item.text : `${item.text.slice(0, PREVIEW_CHARS).trimEnd()}…`;

        return (
          <div key={item.id}>
            {heading}
            <section
              id={`post-${item.id}`}
              style={{
                background: theme.secondaryBg,
                borderRadius: '0.6rem',
                padding: '0.75rem 0.9rem',
                marginBottom: '0.9rem',
                opacity: busy ? 0.7 : 1,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <span style={{ fontWeight: 700, fontSize: '1.05rem' }} title={item.display}>
                  🕒 {localTime(item.scheduledFor)}
                </span>
                <span style={{ color: theme.hint, fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                  {now ? until(item.scheduledFor, now) : ''}
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere', textAlign: 'right' }}>
                  {item.sourceLabel ?? 'unknown source'}
                  <PlatformBadge platform={item.platform} />
                </span>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 20rem), 1fr))',
                  gap: '0.9rem',
                }}
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
                      {fullShown ? 'Less' : 'More'}
                    </button>
                  ) : null}
                  {item.rich ? (
                    <div style={{ color: theme.hint, fontSize: '0.75rem', marginTop: '0.2rem' }}>
                      📰 written in the editor — goes out as laid out there
                    </div>
                  ) : item.edited ? (
                    <div style={{ color: theme.hint, fontSize: '0.75rem', marginTop: '0.2rem' }}>✏️ edited</div>
                  ) : null}

                  {state.kind === 'retiming' ? (
                    <div style={{ marginTop: '0.6rem' }}>
                      <div style={{ fontSize: '0.85rem', marginBottom: '0.35rem' }}>Publish at</div>
                      <input
                        type="datetime-local"
                        value={state.value}
                        autoFocus
                        onChange={(event) => setCard(item.id, { kind: 'retiming', value: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void retime(item, state.value);
                          if (event.key === 'Escape') setCard(item.id, { kind: 'open' });
                        }}
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
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem' }}>
                        <button
                          type="button"
                          onClick={() => {
                            void retime(item, state.value);
                          }}
                          style={{ ...button, background: theme.button, color: theme.buttonText }}
                        >
                          Save time
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setCard(item.id, { kind: 'open' });
                            setError(item.id, null);
                          }}
                          style={{ ...button, background: theme.bg, color: theme.text }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.6rem' }}>
                      <button type="button" disabled={busy} onClick={() => onEdit(item.id, channel.id)} style={smallButton}>
                        ✏️ Edit
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setCard(item.id, { kind: 'retiming', value: localInputValue(new Date(item.scheduledFor)) })}
                        style={smallButton}
                      >
                        🕒 Change time
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          void unschedule(item);
                        }}
                        style={smallButton}
                      >
                        ↩️ Back to review
                      </button>
                      {item.url ? (
                        <button type="button" onClick={() => openLink(item.url)} style={smallButton}>
                          Original ↗
                        </button>
                      ) : null}
                    </div>
                  )}

                  {error ? <p style={{ color: '#e53935', fontSize: '0.85rem', margin: '0.5rem 0 0' }}>{error}</p> : null}
                </div>
              </div>
            </section>
          </div>
        );
      })}
    </>
  );
}
