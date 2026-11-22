'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { PlatformBadge } from '@/app/(app)/platform-badge';
import { readJson, type PanelTools } from '@/components/panel-tools';
import { localInputValue, MediaGallery } from '@/components/review-queue';
import { announceScheduledChanged } from '@/components/scheduled-count';
import { theme } from '@/lib/telegram/webapp-client';

/**
 * The posts approved for a set time and not gone out yet, soonest first, by
 * day: each can be edited, moved to another time, or taken back into the
 * review queue. The scheduler reads a post's text and time only when the
 * time comes, so a change here up to that minute is what goes out.
 *
 * A post scheduled from the draft channel is among them: its time moves here
 * as well, but its text is edited in the draft channel, where it waits.
 *
 * Shown as a list, or as a month's calendar: a day picked there shows its
 * posts under it, as the same cards.
 */

interface ScheduledItem {
  id: number;
  platform: 'x' | 'rss' | 'telegram' | 'youtube' | 'website' | 'threads';
  sourceLabel: string | null;
  url: string;
  text: string;
  media: { kind: 'photo' | 'video'; imageUrl: string | null }[];
  scheduledFor: string;
  display: string;
  edited: boolean;
  rich: boolean;
  /** Scheduled from the draft channel, where it waits: edited there, and opened there by its link. */
  draft?: { id: number; link: string | null };
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
  borderRadius: '999px',
  fontSize: '0.9rem',
  fontWeight: 600,
  cursor: 'pointer',
} as const;

const smallButton = {
  padding: '0.4rem 0.75rem',
  border: `1px solid ${theme.hint}`,
  borderRadius: '999px',
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

type View = 'list' | 'calendar';
const VIEW_KEY = 'zmistik.scheduled.view';

/** The view this browser last used; the list when none, or when storage is closed. */
function storedView(): View {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'calendar' ? 'calendar' : 'list';
  } catch {
    return 'list';
  }
}

function storeView(view: View): void {
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch {
    // A private window: the view is simply not remembered.
  }
}

/** A day in this browser's zone, as a key: "2026-11-20". */
function dayKey(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/** A month as the calendar shows it: its first day. */
interface Month {
  year: number;
  /** 0–11, as Date counts. */
  month: number;
}

const monthOf = (at: Date): Month => ({ year: at.getFullYear(), month: at.getMonth() });

/** The month's weeks, Monday first, with the days of the months either side that fill them. */
function monthGrid({ year, month }: Month): Date[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const weeks = Math.ceil((lead + daysInMonth) / 7);
  return Array.from({ length: weeks * 7 }, (_, index) => new Date(year, month, 1 - lead + index));
}

/** Monday to Sunday, short, in this browser's language. */
const WEEKDAY_NAMES = Array.from({ length: 7 }, (_, index) =>
  // 1 January 2024 was a Monday.
  new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(2024, 0, 1 + index)),
);

/** A day's posts the calendar shows in its cell, before "+N". */
const CELL_POSTS = 3;

export function ScheduledPosts({ request, confirm, openLink, onEdit }: ScheduledPostsProps) {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<number | null>(null);
  const [cards, setCards] = useState<Record<number, CardState>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  /** "Now" for the countdowns, moved on every minute rather than read during render. */
  const [now, setNow] = useState(0);
  const [view, setView] = useState<View>('list');
  /** The calendar's month and its picked day; set when the posts come. */
  const [month, setMonth] = useState<Month | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    request('/api/telegram/webapp/scheduled')
      .then((response) => readJson<{ channels: Channel[] }>(response))
      .then((body) => {
        if (cancelled) return;
        setNow(Date.now());
        setChannels(body.channels);
        // The calendar opens on the soonest post's day, or today when there is none.
        const soonest = body.channels
          .flatMap((channel) => channel.items)
          .map((item) => item.scheduledFor)
          .sort()[0];
        const opening = soonest ? new Date(soonest) : new Date();
        setMonth(monthOf(opening));
        setPicked(dayKey(opening));
        // Read here, not while rendering: the server has no storage to read it from.
        setView(storedView());
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
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const body = await readJson<{ scheduledFor: string; display: string }>(
          item.draft
            ? await request('/api/telegram/webapp/scheduled', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'retime_draft', draftId: item.draft.id, scheduledFor: at.toISOString(), timezone }),
              })
            : await request('/api/telegram/webapp/schedule', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ postId: item.id, scheduledFor: at.toISOString(), timezone }),
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
      const question = item.draft
        ? 'Take this post off the schedule? It stays in the draft channel, waiting.'
        : 'Take this post off the schedule and back into the review queue?';
      if (!(await confirm(question))) return;
      setCard(item.id, { kind: 'saving' });
      setError(item.id, null);
      try {
        await readJson(
          await request('/api/telegram/webapp/scheduled', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(item.draft ? { action: 'unschedule_draft', draftId: item.draft.id } : { action: 'unschedule', postId: item.id }),
          }),
        );
        setCard(item.id, { kind: 'unscheduled' });
        announceScheduledChanged();
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

  /** One post's card, the same in the list and under a calendar day. */
  const renderCard = (item: ScheduledItem, workspaceId: number): ReactNode => {
    const state = cards[item.id] ?? { kind: 'open' };
    const error = errors[item.id];

    if (state.kind === 'unscheduled') {
      return (
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
        {item.draft ? '📝 Unscheduled — waiting in the draft channel' : '↩️ Back in the review queue'} ·{' '}
        {item.sourceLabel ?? 'unknown source'}
      </section>
      );
    }

    const busy = state.kind === 'saving';
    const fullShown = expanded.has(item.id);
    const long = item.text.length > PREVIEW_CHARS;
    const shownText = fullShown || !long ? item.text : `${item.text.slice(0, PREVIEW_CHARS).trimEnd()}…`;

    return (
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
            {item.draft ? (
              <div style={{ color: theme.hint, fontSize: '0.75rem', marginTop: '0.2rem' }}>
                📝 from the draft channel — goes out as the post is there
                {item.edited ? '; edited there, so the text above may be older' : ''}
              </div>
            ) : item.rich ? (
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
                {item.draft ? (
                  item.draft.link ? (
                    <button type="button" onClick={() => openLink(item.draft!.link!)} style={smallButton}>
                      📝 Open in the draft ↗
                    </button>
                  ) : null
                ) : (
                  <button type="button" disabled={busy} onClick={() => onEdit(item.id, workspaceId)} style={smallButton}>
                    ✏️ Edit
                  </button>
                )}
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
                  {item.draft ? '↩️ Unschedule' : '↩️ Back to review'}
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
    );
  };

  const switchView = (next: View) => {
    setView(next);
    storeView(next);
  };

  return (
    <>
      <div role="tablist" aria-label="View" style={{ display: 'flex', gap: '0.25rem', margin: '0.5rem 0' }}>
        {(['list', 'calendar'] as const).map((option) => {
          const active = view === option;
          return (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => switchView(option)}
              style={{
                ...smallButton,
                fontWeight: active ? 600 : 400,
                background: active ? theme.text : 'transparent',
                color: active ? theme.bg : theme.text,
                borderColor: active ? theme.text : theme.hint,
              }}
            >
              {option === 'list' ? '☰ List' : '📅 Calendar'}
            </button>
          );
        })}
      </div>

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
                📢 {candidate.name} · {candidate.items.filter((item) => cards[item.id]?.kind !== 'unscheduled').length}
              </button>
            );
          })}
        </div>
      ) : null}

      {channel ? (
        <p style={{ color: theme.hint, fontSize: '0.85rem', margin: '0 0 0.9rem' }}>
          {waiting === 0
            ? 'Nothing scheduled. Use 🕒 Schedule on a post in the review queue.'
            : view === 'list'
              ? `${waiting} scheduled · soonest first · the bot publishes each within a minute of its time`
              : `${waiting} scheduled · pick a day to see its posts`}
        </p>
      ) : null}

      {channel && view === 'list'
        ? channel.items.map((item, index) => {
            const day = dayLabel(item.scheduledFor, now);
            const newDay = index === 0 || dayLabel(channel.items[index - 1]!.scheduledFor, now) !== day;
            return (
              <div key={item.id}>
                {newDay ? (
                  <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: theme.hint, margin: '1.1rem 0 0.5rem' }}>{day}</h2>
                ) : null}
                {renderCard(item, channel.id)}
              </div>
            );
          })
        : null}

      {channel && view === 'calendar' && month && now ? (
        <Calendar
          items={channel.items.filter((item) => cards[item.id]?.kind !== 'unscheduled')}
          month={month}
          onMonth={setMonth}
          picked={picked}
          onPick={(key, postId) => {
            setPicked(key);
            if (postId !== undefined) {
              // After the picked day's cards render under the calendar.
              setTimeout(() => document.getElementById(`post-${postId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
            }
          }}
          now={now}
        />
      ) : null}

      {channel && view === 'calendar' && picked ? (
        <PickedDay
          dayKey={picked}
          // A post taken off the schedule here keeps its card, saying where it went.
          items={channel.items.filter((item) => dayKey(new Date(item.scheduledFor)) === picked)}
          now={now}
        >
          {(item) => renderCard(item, channel.id)}
        </PickedDay>
      ) : null}
    </>
  );
}

/**
 * A month of days, Monday first: each with the times of its posts, which pick
 * the day and go to that post's card below; the day itself picks the day.
 */
function Calendar({
  items,
  month,
  onMonth,
  picked,
  onPick,
  now,
}: {
  items: ScheduledItem[];
  month: Month;
  onMonth: (month: Month) => void;
  picked: string | null;
  onPick: (dayKey: string, postId?: number) => void;
  now: number;
}) {
  const byDay = new Map<string, ScheduledItem[]>();
  for (const item of items) {
    const key = dayKey(new Date(item.scheduledFor));
    byDay.set(key, [...(byDay.get(key) ?? []), item]);
  }
  const today = dayKey(new Date(now));
  const step = (by: number) => onMonth(monthOf(new Date(month.year, month.month + by, 1)));
  const title = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(month.year, month.month, 1));
  const inMonth = items.filter((item) => {
    const at = new Date(item.scheduledFor);
    return at.getFullYear() === month.year && at.getMonth() === month.month;
  }).length;

  return (
    <div style={{ marginBottom: '1rem' }}>
      {/* Which a cell shows, by its width: the posts' times, or how many there are. */}
      <style>{`
        .z-cal-count { display: none; }
        @media (max-width: 560px) {
          .z-cal-post { display: none !important; }
          .z-cal-count { display: block; }
          .z-cal-day { min-height: 3.4rem !important; }
        }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.5rem' }}>
        <button type="button" aria-label="Previous month" onClick={() => step(-1)} style={smallButton}>
          ‹
        </button>
        <button type="button" aria-label="Next month" onClick={() => step(1)} style={smallButton}>
          ›
        </button>
        <strong style={{ fontSize: '1.05rem', textTransform: 'capitalize' }}>{title}</strong>
        <span style={{ color: theme.hint, fontSize: '0.8rem' }}>{inMonth > 0 ? `· ${inMonth}` : ''}</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => {
            onMonth(monthOf(new Date(now)));
            onPick(today);
          }}
          style={smallButton}
        >
          Today
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: '0.25rem' }}>
        {WEEKDAY_NAMES.map((name) => (
          <div key={name} style={{ color: theme.hint, fontSize: '0.72rem', textAlign: 'center', padding: '0.15rem 0' }}>
            {name}
          </div>
        ))}

        {monthGrid(month).map((date) => {
          const key = dayKey(date);
          const posts = byDay.get(key) ?? [];
          const outside = date.getMonth() !== month.month;
          const past = key < today;
          const isPicked = key === picked;
          const isToday = key === today;
          return (
            <div
              key={key}
              className="z-cal-day"
              role="button"
              tabIndex={0}
              aria-label={`${new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(date)}${posts.length > 0 ? `, ${posts.length} scheduled` : ''}`}
              aria-pressed={isPicked}
              onClick={() => onPick(key)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onPick(key);
                }
              }}
              style={{
                minWidth: 0,
                minHeight: '4.8rem',
                padding: '0.25rem',
                boxSizing: 'border-box',
                borderRadius: '0.4rem',
                background: theme.secondaryBg,
                border: `2px solid ${isPicked ? theme.text : 'transparent'}`,
                opacity: outside || past ? 0.5 : 1,
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.15rem',
              }}
            >
              <span
                style={{
                  alignSelf: 'flex-start',
                  fontSize: '0.75rem',
                  fontWeight: isToday ? 800 : 500,
                  fontVariantNumeric: 'tabular-nums',
                  padding: '0 0.3rem',
                  borderRadius: '999px',
                  background: isToday ? theme.mark : 'transparent',
                  color: isToday ? theme.markInk : theme.text,
                }}
              >
                {date.getDate()}
              </span>
              {posts.length > 0 ? (
                // On a phone a cell is too narrow for times: how many, and the day's cards below.
                <span
                  className="z-cal-count"
                  style={{
                    alignSelf: 'center',
                    marginTop: 'auto',
                    minWidth: '1.3rem',
                    padding: '0.05rem 0.3rem',
                    boxSizing: 'border-box',
                    borderRadius: '999px',
                    background: theme.text,
                    color: theme.bg,
                    fontSize: '0.72rem',
                    fontWeight: 700,
                    textAlign: 'center',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {posts.length}
                </span>
              ) : null}
              {posts.slice(0, CELL_POSTS).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="z-cal-post"
                  title={`${localTime(item.scheduledFor)} · ${item.sourceLabel ?? 'unknown source'}${item.draft ? ' · from the draft channel' : ''}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onPick(key, item.id);
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '0.1rem 0.25rem',
                    border: item.draft ? `1px dashed ${theme.hint}` : '1px solid transparent',
                    borderRadius: '4px',
                    background: theme.bg,
                    color: theme.text,
                    fontSize: '0.7rem',
                    lineHeight: 1.3,
                    textAlign: 'left',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{localTime(item.scheduledFor)}</strong>{' '}
                  <span style={{ color: theme.hint }}>{item.sourceLabel ?? ''}</span>
                </button>
              ))}
              {posts.length > CELL_POSTS ? (
                <span className="z-cal-post" style={{ fontSize: '0.68rem', color: theme.hint, paddingLeft: '0.25rem' }}>
                  +{posts.length - CELL_POSTS}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The picked day's posts, under the calendar, as cards. */
function PickedDay({
  dayKey: key,
  items,
  now,
  children,
}: {
  dayKey: string;
  items: ScheduledItem[];
  now: number;
  children: (item: ScheduledItem) => ReactNode;
}) {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day);
  const label = dayLabel(date.toISOString(), now);
  return (
    <>
      <h2 style={{ fontSize: '0.95rem', fontWeight: 700, margin: '0 0 0.6rem' }}>
        {label === 'Today' || label === 'Tomorrow'
          ? `${label}, ${new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(date)}`
          : label}
        <span style={{ color: theme.hint, fontWeight: 400 }}>{items.length > 0 ? ` · ${items.length}` : ''}</span>
      </h2>
      {items.length === 0 ? (
        <p style={{ color: theme.hint, fontSize: '0.85rem' }}>Nothing scheduled on this day.</p>
      ) : (
        items.map((item) => <div key={item.id}>{children(item)}</div>)
      )}
    </>
  );
}
