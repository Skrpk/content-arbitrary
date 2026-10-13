import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { processedPosts, workspaces, type ReviewLinkTarget, type SourcePlatform, type Workspace } from '@/db/schema';
import type { Database } from '@/lib/db';
import type { Env } from '@/lib/env';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { findReviewScores, type ReviewScore } from '@/lib/radar/review-note';
import { findRepeats, repeatOutcome, type Repeat } from '@/lib/stories/repeats';
import { publishedInStories, storiesOf } from '@/lib/review/same-story';
import { richDocumentPlainText } from '@/lib/rich/document';
import { platformOfPostId, sourceLabelOfPost } from '@/lib/sources/display';
import type { TelegramClient } from '@/lib/telegram/client';
import type { InlineKeyboardButton } from '@/lib/telegram/send-media';
import { reviewLinkFor } from '@/lib/accounts/users';
import { escapeHtml, TELEGRAM_PARSE_MODE } from '@/lib/telegram/format-caption';
import { captionToPlainText, parsePostFooter, stripFooter } from '@/lib/telegram/post-footer';
import { usesReviewQueue } from '@/lib/workspace';

/**
 * The review queue: posts waiting for a decision, gathered on one Mini App
 * page instead of arriving in the chat one by one, best Radar score first.
 *
 * The reviewer is told about it by a notification with a button to the page,
 * sent at most once per the tenant's interval and only when a post has joined
 * the queue since the newest one the last notification counted — so a quiet
 * stretch sends nothing at all. Each
 * notification replaces the one before it, leaving one in the chat.
 *
 * Radar only orders the page. Every post is on it, whatever it scored, and
 * the decision on each is the reviewer's.
 */

/** Posts the page shows at most, newest first before sorting; the rest wait their turn. */
export const REVIEW_QUEUE_PAGE_LIMIT = 300;

/**
 * Taken off the interval when deciding whether a notification is due. Cron
 * runs start a few seconds either side of the quarter hour, so an hourly
 * notification sent at 10:00:07 is still due at 11:00:02 rather than slipping
 * to 11:15.
 */
export const REVIEW_DIGEST_SLACK_MS = 3 * 60 * 1000;

/** Absolute URL of the review queue page, opened on one channel when given. */
export function buildReviewQueueUrl(baseUrl: string, workspaceId?: number): string {
  const base = `${baseUrl.replace(/\/+$/, '')}/queue`;
  return workspaceId === undefined ? base : `${base}?workspace=${workspaceId}`;
}

/**
 * The bot's "Open review queue" button: the website, in the browser, for
 * someone who chose it and when there is one; otherwise the Mini App, inside
 * Telegram. The two pages are at the same path on their own hosts. Null when
 * there is neither.
 */
export function reviewQueueButton(input: {
  appBaseUrl: string | undefined;
  webAppUrl: string | undefined;
  target: ReviewLinkTarget;
  workspaceId?: number;
}): InlineKeyboardButton | null {
  const text = '📋 Open review queue';
  if (input.target === 'website' && input.webAppUrl) {
    return { text, url: buildReviewQueueUrl(input.webAppUrl, input.workspaceId) };
  }
  if (input.appBaseUrl) return { text, web_app: { url: buildReviewQueueUrl(input.appBaseUrl, input.workspaceId) } };
  return null;
}

/**
 * How many posts await review in a channel; how many of them joined the queue
 * after `since` — all queued ones when null — and when the newest of those did.
 */
export async function countReviewQueue(
  db: Database,
  workspaceId: number,
  since: Date | null,
): Promise<{ waiting: number; fresh: number; newestQueuedAt: Date | null }> {
  const isFresh = since
    ? sql`${processedPosts.reviewQueuedAt} > ${since.toISOString()}::timestamptz`
    : sql`${processedPosts.reviewQueuedAt} is not null`;

  // Raw fragments: the driver is handed the time as text, which Postgres reads as a timestamp.
  const [row] = await db
    .select({
      waiting: count(),
      fresh: sql<number>`count(*) filter (where ${isFresh})`.mapWith(Number),
      newest: sql<string | null>`max(${processedPosts.reviewQueuedAt}) filter (where ${isFresh})`,
    })
    .from(processedPosts)
    .where(and(eq(processedPosts.workspaceId, workspaceId), eq(processedPosts.status, 'awaiting_approval')));

  return {
    waiting: row?.waiting ?? 0,
    fresh: row?.fresh ?? 0,
    newestQueuedAt: row?.newest ? new Date(row.newest) : null,
  };
}

/** One post on the queue page — everything shown, nothing that is not. */
export interface ReviewQueueItem {
  id: number;
  platform: SourcePlatform;
  /** `@handle`, a channel's `@username`, or a feed's title. */
  sourceLabel: string | null;
  /** The post on X or in its channel, or the feed entry's article; empty when it links nowhere. */
  url: string;
  /** When the author posted it, as the source reported; null when it did not say. */
  postedAt: string | null;
  /** The text it will be published with, as plain text, without the channel's footer. */
  text: string;
  /** The whole text, when it is too long for a caption and follows the media as its own message. */
  fullText: string | null;
  /** A picture for each item: a photo, or a video's still; null when there is none to show. */
  media: { kind: 'photo' | 'video'; imageUrl: string | null }[];
  score: ReviewScore | null;
  /** A post its source sent before: when the earlier copy came, and what became of it. */
  repeat: { arrivedAt: string; outcome: string } | null;
  /** Edited by the reviewer since it came in. */
  edited: boolean;
  /** Written in the website's editor: published as a rich message, as written there. */
  rich: boolean;
  /**
   * The other waiting posts of its story, from other sources or the same:
   * one card, decided together. Empty for a post alone in its story, and
   * always for these others themselves.
   */
  alsoInStory: ReviewQueueItem[];
  /** What of its story the channel has already published or scheduled. */
  storyPublished: { sourceLabel: string | null; approvedAt: string }[];
}

/**
 * A channel's queue as the page shows it: best Radar score first; posts with
 * no score — Radar off for the channel, or it failed — after them, newest
 * first.
 */
export async function loadReviewQueue(
  db: Database,
  workspace: Pick<Workspace, 'id' | 'postFooter'>,
): Promise<{ items: ReviewQueueItem[]; waiting: number }> {
  const rows = await db
    .select({
      id: processedPosts.id,
      externalId: processedPosts.externalId,
      xPostUrl: processedPosts.xPostUrl,
      xAuthorUsername: processedPosts.xAuthorUsername,
      xCreatedAt: processedPosts.xCreatedAt,
      caption: processedPosts.caption,
      approvalPayload: processedPosts.approvalPayload,
      reviewMedia: processedPosts.reviewMedia,
      captionEditedAt: processedPosts.captionEditedAt,
      richDoc: processedPosts.richDoc,
      createdAt: processedPosts.createdAt,
    })
    .from(processedPosts)
    .where(and(eq(processedPosts.workspaceId, workspace.id), eq(processedPosts.status, 'awaiting_approval')))
    .orderBy(desc(processedPosts.id))
    .limit(REVIEW_QUEUE_PAGE_LIMIT);

  const { waiting } = await countReviewQueue(db, workspace.id, null);
  const ids = rows.map((row) => row.id);
  const [scores, repeats] = await Promise.all([findReviewScores(db, ids), findRepeats(db, ids)]);
  const footer = parsePostFooter(workspace.postFooter);

  const items = rows.map((row): ReviewQueueItem => {
    const stored = row.caption ?? row.approvalPayload?.caption ?? '';
    const body = stripFooter(stored, footer);
    const overflow = row.approvalPayload?.overflowMessage;
    const overflowBody = overflow ? (stripFooter(overflow, footer) ?? overflow) : null;

    return {
      id: row.id,
      platform: platformOfPostId(row.externalId),
      sourceLabel: sourceLabelOfPost(row.externalId, row.xAuthorUsername),
      url: row.xPostUrl,
      postedAt: (row.xCreatedAt ?? row.createdAt).toISOString(),
      text: row.richDoc ? richDocumentPlainText(row.richDoc) : captionToPlainText(body ?? stored),
      fullText: !row.richDoc && overflowBody ? captionToPlainText(overflowBody) : null,
      media: (row.reviewMedia ?? []).map((item) => ({
        kind: item.kind,
        imageUrl: (item.kind === 'photo' ? item.url : item.previewUrl) ?? null,
      })),
      score: scores.get(row.id) ?? null,
      repeat: repeatOf(repeats.get(row.id)),
      edited: row.captionEditedAt !== null,
      rich: row.richDoc !== null,
      alsoInStory: [],
      storyPublished: [],
    };
  });

  // Newest first already; a stable sort keeps that order among equal scores.
  items.sort((a, b) => (b.score?.score ?? -1) - (a.score?.score ?? -1));
  return { items: await groupByStory(db, workspace.id, items), waiting };
}

/**
 * One card per story: its best-scored waiting post leads, in that post's
 * place in the list, and the others go under it.
 */
async function groupByStory(db: Database, workspaceId: number, items: ReviewQueueItem[]): Promise<ReviewQueueItem[]> {
  const storyOf = await storiesOf(
    db,
    items.map((item) => item.id),
  );
  const published = await publishedInStories(db, workspaceId, [...new Set(storyOf.values())]);
  const leads: ReviewQueueItem[] = [];
  const leadOfStory = new Map<number, ReviewQueueItem>();
  for (const item of items) {
    const storyId = storyOf.get(item.id);
    const lead = storyId === undefined ? undefined : leadOfStory.get(storyId);
    if (lead) {
      lead.alsoInStory.push(item);
      continue;
    }
    if (storyId !== undefined) {
      leadOfStory.set(storyId, item);
      item.storyPublished = (published.get(storyId) ?? []).map((entry) => ({
        sourceLabel: entry.sourceLabel,
        approvedAt: entry.approvedAt.toISOString(),
      }));
    }
    leads.push(item);
  }
  return leads;
}

function repeatOf(repeat: Repeat | undefined): ReviewQueueItem['repeat'] {
  return repeat ? { arrivedAt: repeat.arrivedAt.toISOString(), outcome: repeatOutcome(repeat.status) } : null;
}

/**
 * Whether a channel's notification is due. The first one is due at once — or,
 * with an hour set, at that hour — and whether there is anything to tell is
 * asked separately.
 *
 * Without an hour: once the interval has passed since the last one. With an
 * hour (intervals of a day or more): at that hour, local to the reviewer, on
 * the day the interval comes round — so a daily notification keeps to the
 * evening across the clocks changing, and moving the hour moves the next one.
 */
export function reviewDigestIsDue(
  workspace: Pick<Workspace, 'reviewDigestMinutes' | 'reviewDigestSentAt' | 'reviewDigestHour' | 'reviewDigestTimezone'>,
  now: Date,
): boolean {
  const minutes = workspace.reviewDigestMinutes;
  if (minutes === null) return false;
  const sentAt = workspace.reviewDigestSentAt;
  const { reviewDigestHour: hour, reviewDigestTimezone: timeZone } = workspace;

  if (hour !== null && timeZone && minutes >= DAY_MINUTES) {
    const next = sentAt ? nextDigestAt(sentAt, minutes, hour, timeZone) : hourOnLocalDay(now, hour, timeZone);
    return now.getTime() >= next.getTime() - REVIEW_DIGEST_SLACK_MS;
  }

  if (!sentAt) return true;
  return now.getTime() - sentAt.getTime() >= minutes * 60 * 1000 - REVIEW_DIGEST_SLACK_MS;
}

const DAY_MINUTES = 24 * 60;
const DAY_MS = DAY_MINUTES * 60 * 1000;

/**
 * When the notification after one sent at `sentAt` goes out: the interval
 * on, at the hour — on whichever day puts the hour nearest to that, so a
 * notification sent a few minutes late does not push the next one a day.
 */
export function nextDigestAt(sentAt: Date, minutes: number, hour: number, timeZone: string): Date {
  const target = new Date(sentAt.getTime() + minutes * 60 * 1000);
  let slot = hourOnLocalDay(target, hour, timeZone);
  if (slot.getTime() - target.getTime() > DAY_MS / 2) slot = hourOnLocalDay(new Date(target.getTime() - DAY_MS), hour, timeZone);
  else if (target.getTime() - slot.getTime() > DAY_MS / 2) slot = hourOnLocalDay(new Date(target.getTime() + DAY_MS), hour, timeZone);
  return slot;
}

/** `hour`:00 in `timeZone` on the local calendar day `at` falls on there. */
function hourOnLocalDay(at: Date, hour: number, timeZone: string): Date {
  const { year, month, day } = localParts(at, timeZone);
  const asIfUtc = Date.UTC(year, month - 1, day, hour);
  // The zone's offset at that moment, found twice: the first guess may sit on
  // the other side of a clock change.
  const first = asIfUtc - offsetMs(new Date(asIfUtc), timeZone);
  return new Date(asIfUtc - offsetMs(new Date(first), timeZone));
}

function localParts(at: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  return parts;
}

/** How far ahead of UTC `timeZone` is at `at`, in milliseconds. */
function offsetMs(at: Date, timeZone: string): number {
  const p = localParts(at, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000;
}

/** The notification's text. Telegram HTML: the channel's name is escaped. */
export function formatReviewDigest(input: { fresh: number; waiting: number; channel?: string | null }): string {
  const posts = (n: number) => `${n} post${n === 1 ? '' : 's'}`;
  return [
    ...(input.channel ? [`📢 ${escapeHtml(input.channel)}`] : []),
    `📥 <b>${posts(input.fresh)}</b> new for review` +
      (input.waiting > input.fresh ? ` · ${input.waiting} waiting in all` : ''),
    'Best Radar score first.',
  ].join('\n');
}

export type ReviewDigestOutcome =
  | { sent: true; fresh: number; waiting: number }
  | { sent: false; reason: 'not-queued' | 'not-due' | 'nothing-new' | 'failed' };

/**
 * Tell the reviewer about new posts in the queue, if the channel's interval
 * has passed and any have come in since the last notification. The one
 * before is then deleted, so only the latest stays in the chat.
 *
 * Run inside the tenant's sync lock, so two overlapping runs cannot both
 * decide to send. Never throws: a notification that fails is tried again on
 * the next run, and nothing is lost meanwhile — the posts are in the queue.
 */
export async function sendReviewDigest(input: {
  db: Database;
  env: Pick<Env, 'REQUIRE_APPROVAL' | 'APP_BASE_URL' | 'WEB_APP_URL'>;
  client: TelegramClient;
  workspace: Workspace;
  /** The reviewer's name for the channel, when they review several. */
  channelLabel?: string | null;
  now?: Date;
  logger: Logger;
}): Promise<ReviewDigestOutcome> {
  const { db, client, workspace, logger } = input;
  const now = input.now ?? new Date();
  const adminChatId = workspace.telegramAdminChatId;

  if (!usesReviewQueue(workspace, input.env) || !adminChatId || !input.env.APP_BASE_URL) {
    return { sent: false, reason: 'not-queued' };
  }
  if (!reviewDigestIsDue(workspace, now)) return { sent: false, reason: 'not-due' };

  try {
    const { waiting, fresh, newestQueuedAt } = await countReviewQueue(
      db,
      workspace.id,
      workspace.reviewDigestCoveredUntil,
    );
    if (fresh === 0) return { sent: false, reason: 'nothing-new' };

    const button = reviewQueueButton({
      appBaseUrl: input.env.APP_BASE_URL,
      webAppUrl: input.env.WEB_APP_URL,
      target: await reviewLinkFor(db, adminChatId),
      workspaceId: workspace.id,
    })!;
    const message = await client.call(
      'sendMessage',
      {
        chat_id: adminChatId,
        text: formatReviewDigest({ fresh, waiting, channel: input.channelLabel }),
        parse_mode: TELEGRAM_PARSE_MODE,
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [[button]] },
      },
      z.object({ message_id: z.number() }),
    );

    await db
      .update(workspaces)
      .set({
        reviewDigestSentAt: now,
        reviewDigestCoveredUntil: newestQueuedAt,
        reviewDigestMessageId: message.message_id,
      })
      .where(eq(workspaces.id, workspace.id));

    // The previous one is out of date now. Best effort: Telegram lets a bot
    // delete its own message for 48 hours, and an older one simply stays.
    if (workspace.reviewDigestMessageId) {
      await client.deleteMessage(adminChatId, workspace.reviewDigestMessageId).catch((error: unknown) => {
        logger.info('review_digest.previous_not_deleted', { error: describeError(error) });
      });
    }

    logger.info('review_digest.sent', { workspaceId: workspace.id, fresh, waiting });
    return { sent: true, fresh, waiting };
  } catch (error) {
    logger.error('review_digest.failed', { workspaceId: workspace.id, error: describeError(error) });
    return { sent: false, reason: 'failed' };
  }
}

/** How many posts await review in each of these channels; a channel with none is absent. */
export async function countWaitingByWorkspace(db: Database, workspaceIds: number[]): Promise<Map<number, number>> {
  if (workspaceIds.length === 0) return new Map();
  const rows = await db
    .select({ workspaceId: processedPosts.workspaceId, waiting: count() })
    .from(processedPosts)
    .where(and(eq(processedPosts.status, 'awaiting_approval'), inArray(processedPosts.workspaceId, workspaceIds)))
    .groupBy(processedPosts.workspaceId);
  return new Map(rows.map((row) => [row.workspaceId, row.waiting]));
}
