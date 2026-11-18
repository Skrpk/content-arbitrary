import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql as rawSql } from 'drizzle-orm';
import {
  channelDrafts,
  processedPosts,
  telegramMessages,
  workspaces,
  type ChannelDraft,
  type DraftStatus,
  type Workspace,
} from '@/db/schema';
import type { Database } from '@/lib/db';
import type { Env } from '@/lib/env';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { formatScheduleTime } from '@/lib/sync/approval';
import type { TelegramClient } from '@/lib/telegram/client';
import { TELEGRAM_PARSE_MODE, escapeHtml } from '@/lib/telegram/format-caption';
import { sendText, type InlineKeyboardMarkup } from '@/lib/telegram/send-media';

/**
 * The draft channel: an approved post goes there first, as a preview.
 *
 * A channel with a draft channel (workspaces.draft_chat_id) publishes each
 * approved post there instead, and puts a control message under it — a reply
 * with the buttons. The reviewer looks the post over in Telegram, edits it
 * there if they like, and sends it on: Publish now, or a time typed in reply
 * to the control message. What reaches the channel is a copy of the post's
 * messages as they are at that moment (copyMessages): edits included, an
 * album kept an album, media copied inside Telegram rather than downloaded
 * and sent again, and no "Forwarded from".
 *
 * The control message stays when it is done, saying where the post went.
 *
 * The post itself is settled as published when it reaches the draft channel,
 * as any approved post is; its row here is the second step. Once it reaches
 * the channel, the post's record points at the channel's copy. Rejected here,
 * it is recorded as rejected, as if turned down in review.
 */

/** Drafts a run sends on; a minute later the rest are due again. */
export const DRAFTS_PER_RUN = 5;

/** How long a control message that failed to send is left before it is tried again. */
const CONTROL_RETRY_AFTER_MS = 60_000;

/** What a draft's own buttons ask for. */
export type DraftAction = 'publish' | 'schedule_hint' | 'unschedule' | 'reject' | 'restore';

const DRAFT_ACTION_CODES: Record<DraftAction, string> = {
  publish: 'dn',
  schedule_hint: 'dt',
  unschedule: 'du',
  reject: 'dr',
  restore: 'dx',
};
const DRAFT_ACTIONS_BY_CODE = Object.fromEntries(
  Object.entries(DRAFT_ACTION_CODES).map(([action, code]) => [code, action]),
) as Record<string, DraftAction>;

export function buildDraftCallbackData(action: DraftAction, draftId: number): string {
  return `${DRAFT_ACTION_CODES[action]}:${draftId}`;
}

export function parseDraftCallbackData(data: string | undefined): { action: DraftAction; draftId: number } | null {
  const match = /^(dn|dt|du|dr|dx):(\d{1,12})$/.exec(data?.trim() ?? '');
  if (!match) return null;
  const draftId = Number(match[2]);
  if (!Number.isSafeInteger(draftId) || draftId <= 0) return null;
  return { action: DRAFT_ACTIONS_BY_CODE[match[1]!]!, draftId };
}

/** How to type a time, as the control message and the Schedule button say it. */
export const DRAFT_TIME_EXAMPLES = '18:30 · tomorrow 9:00 · fri 18:00 · 21.11 18:30';

/** A message's address for people in the channel: works for a private channel as for a public one. */
export function messageLink(chatId: string, messageId: number): string | null {
  const internal = /^-100(\d+)$/.exec(chatId);
  return internal ? `https://t.me/c/${internal[1]}/${messageId}` : null;
}

/** The control message as the draft stands: its text and its buttons. */
export function draftControl(
  draft: Pick<
    ChannelDraft,
    'id' | 'status' | 'scheduledFor' | 'scheduledTimezone' | 'editedAt' | 'error' | 'publishedChatId' | 'publishedMessageIds' | 'publishedAt'
  >,
  context: { channel: string; sourceUrl?: string | null },
): { text: string; keyboard: InlineKeyboardMarkup } {
  const channel = `<b>${escapeHtml(context.channel)}</b>`;
  const source = context.sourceUrl ? [`Source: ${escapeHtml(context.sourceUrl)}`] : [];
  const edited = draft.editedAt ? ['✏️ Edited here — the post as it is now is what goes out.'] : [];
  const error = draft.error ? [`⚠️ ${escapeHtml(draft.error.slice(0, 300))}`] : [];
  const button = (text: string, action: DraftAction) => ({ text, callback_data: buildDraftCallbackData(action, draft.id) });

  if (draft.status === 'published') {
    const first = draft.publishedMessageIds?.[0];
    const link = draft.publishedChatId && first ? messageLink(draft.publishedChatId, first) : null;
    const when = draft.publishedAt ? ` · ${escapeHtml(formatScheduleTime(draft.publishedAt, draft.scheduledTimezone))}` : '';
    return {
      text: [`✅ Published to ${channel}${when}`, ...source].join('\n'),
      keyboard: { inline_keyboard: link ? [[{ text: '↗️ Open', url: link }]] : [] },
    };
  }
  if (draft.status === 'rejected') {
    return {
      text: [`🗑 Rejected — not published to ${channel}.`, ...source].join('\n'),
      keyboard: { inline_keyboard: [[button('↩️ Restore', 'restore')]] },
    };
  }
  if (draft.status === 'publishing') {
    return { text: [`⏳ Publishing to ${channel}…`, ...source].join('\n'), keyboard: { inline_keyboard: [] } };
  }
  if (draft.status === 'scheduled' && draft.scheduledFor) {
    return {
      text: [
        `🕒 Scheduled for ${escapeHtml(formatScheduleTime(draft.scheduledFor, draft.scheduledTimezone))} → ${channel}`,
        ...source,
        ...edited,
        ...error,
        '',
        `To move it, reply to this message with another time: <code>${DRAFT_TIME_EXAMPLES}</code>`,
      ].join('\n'),
      keyboard: {
        inline_keyboard: [
          [button('🚀 Publish now', 'publish'), button('↩️ Unschedule', 'unschedule')],
          [button('🗑 Reject', 'reject')],
        ],
      },
    };
  }
  return {
    text: [
      `📝 Draft for ${channel}`,
      ...source,
      ...edited,
      ...error,
      '',
      'Edit the post above here in Telegram if you like: what goes out is the post as it is then.',
      `To schedule it, reply to this message with a time: <code>${DRAFT_TIME_EXAMPLES}</code>`,
    ].join('\n'),
    keyboard: {
      inline_keyboard: [
        [button('🚀 Publish now', 'publish'), button('⏰ Schedule', 'schedule_hint')],
        [button('🗑 Reject', 'reject')],
      ],
    },
  };
}

/** The zone a typed time is read in: the reviewer's, as their browser last told us. */
export async function draftTimeZone(db: Database, workspace: Pick<Workspace, 'id' | 'reviewDigestTimezone'>): Promise<string> {
  if (workspace.reviewDigestTimezone) return workspace.reviewDigestTimezone;
  const [scheduled] = await db
    .select({ timezone: processedPosts.scheduledTimezone })
    .from(processedPosts)
    .where(and(eq(processedPosts.workspaceId, workspace.id), isNotNull(processedPosts.scheduledTimezone)))
    .orderBy(desc(processedPosts.updatedAt))
    .limit(1);
  return scheduled?.timezone ?? 'UTC';
}

export interface DraftsContext {
  db: Database;
  client: TelegramClient;
  logger: Logger;
}

async function contextOf(db: Database, draft: ChannelDraft): Promise<{ channel: string; sourceUrl: string | null }> {
  const [row] = await db
    .select({ channel: workspaces.name, sourceUrl: processedPosts.xPostUrl })
    .from(processedPosts)
    .innerJoin(workspaces, eq(workspaces.id, processedPosts.workspaceId))
    .where(eq(processedPosts.id, draft.processedPostId))
    .limit(1);
  return { channel: row?.channel ?? 'the channel', sourceUrl: row?.sourceUrl || null };
}

/**
 * A post just published to the draft channel: its row, and its control
 * message under it. The control message is best effort — the post is in the
 * draft channel either way, and a later run sends one that failed.
 */
export async function openDraft(
  context: DraftsContext,
  input: { postId: number; workspaceId: number; draftChatId: string; messageIds: number[] },
): Promise<ChannelDraft> {
  const [workspace] = await context.db
    .select({ id: workspaces.id, reviewDigestTimezone: workspaces.reviewDigestTimezone })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .limit(1);
  const [draft] = await context.db
    .insert(channelDrafts)
    .values({
      processedPostId: input.postId,
      workspaceId: input.workspaceId,
      draftChatId: input.draftChatId,
      messageIds: [...input.messageIds].sort((a, b) => a - b),
      // Times on its control message are shown in the reviewer's zone from the start.
      scheduledTimezone: workspace ? await draftTimeZone(context.db, workspace) : null,
    })
    .returning();
  await sendControl(context, draft!).catch((error: unknown) => {
    context.logger.warn('draft.control_failed', { draftId: draft!.id, error: describeError(error) });
  });
  return draft!;
}

async function sendControl(context: DraftsContext, draft: ChannelDraft): Promise<void> {
  const { text, keyboard } = draftControl(draft, await contextOf(context.db, draft));
  const sent = await sendText(
    { client: context.client, chatId: draft.draftChatId, disableNotification: true, replyMarkup: keyboard },
    text,
    { replyToMessageId: draft.messageIds[0] },
  );
  await context.db
    .update(channelDrafts)
    .set({ controlMessageId: sent.message_id, updatedAt: new Date() })
    .where(eq(channelDrafts.id, draft.id));
}

/** Brings the control message up to date with the draft. */
export async function refreshControl(context: DraftsContext, draft: ChannelDraft): Promise<void> {
  if (!draft.controlMessageId) return;
  const { text, keyboard } = draftControl(draft, await contextOf(context.db, draft));
  await context.client
    .editMessageText(draft.draftChatId, draft.controlMessageId, text, TELEGRAM_PARSE_MODE, keyboard)
    .catch((error: unknown) => {
      const message = describeError(error);
      // Pressed twice, or edited to what it already says: the screen is right.
      if (/message is not modified/i.test(message)) return;
      context.logger.warn('draft.control_refresh_failed', { draftId: draft.id, error: message });
    });
}

export async function findDraft(db: Database, id: number): Promise<ChannelDraft | null> {
  const [draft] = await db.select().from(channelDrafts).where(eq(channelDrafts.id, id)).limit(1);
  return draft ?? null;
}

/** The draft whose control message this is. */
export async function findDraftByControl(db: Database, chatId: string, controlMessageId: number): Promise<ChannelDraft | null> {
  const [draft] = await db
    .select()
    .from(channelDrafts)
    .where(and(eq(channelDrafts.draftChatId, chatId), eq(channelDrafts.controlMessageId, controlMessageId)))
    .limit(1);
  return draft ?? null;
}

/** Moves a draft from one of `from` to `set.status`, or returns null when it was not in one of them. */
async function transition(
  db: Database,
  id: number,
  from: DraftStatus[],
  set: Partial<typeof channelDrafts.$inferInsert> & { status: DraftStatus },
  extra?: ReturnType<typeof lte>,
): Promise<ChannelDraft | null> {
  const [draft] = await db
    .update(channelDrafts)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(channelDrafts.id, id), inArray(channelDrafts.status, from), ...(extra ? [extra] : [])))
    .returning();
  return draft ?? null;
}

export async function scheduleDraft(
  context: DraftsContext,
  input: { id: number; at: Date; timezone: string },
): Promise<ChannelDraft | null> {
  const draft = await transition(context.db, input.id, ['waiting', 'scheduled'], {
    status: 'scheduled',
    scheduledFor: input.at,
    scheduledTimezone: input.timezone,
    attempts: 0,
    error: null,
  });
  if (draft) await refreshControl(context, draft);
  return draft;
}

export async function unscheduleDraft(context: DraftsContext, id: number): Promise<ChannelDraft | null> {
  const draft = await transition(context.db, id, ['scheduled'], { status: 'waiting', scheduledFor: null, attempts: 0, error: null });
  if (draft) await refreshControl(context, draft);
  return draft;
}

/** Says on the control message why a reply was not taken as a time. */
export async function noteDraftProblem(context: DraftsContext, draft: ChannelDraft, problem: string): Promise<void> {
  const noted = await transition(context.db, draft.id, ['waiting', 'scheduled'], { status: draft.status, error: problem });
  if (noted) await refreshControl(context, noted);
}

/** Turned down in the draft channel: recorded on the post as a rejection, as if in review. */
export async function rejectDraft(context: DraftsContext, id: number): Promise<ChannelDraft | null> {
  const draft = await transition(context.db, id, ['waiting', 'scheduled'], { status: 'rejected', scheduledFor: null, error: null });
  if (!draft) return null;
  await context.db
    .update(processedPosts)
    .set({ status: 'rejected', rejectionReason: 'other', rejectionNote: 'Rejected in the draft channel', updatedAt: new Date() })
    .where(and(eq(processedPosts.id, draft.processedPostId), eq(processedPosts.status, 'published')));
  await refreshControl(context, draft);
  return draft;
}

/** Undoes a rejection in the draft channel: the post is back where it was. */
export async function restoreDraft(context: DraftsContext, id: number): Promise<ChannelDraft | null> {
  const draft = await transition(context.db, id, ['rejected'], { status: 'waiting' });
  if (!draft) return null;
  await context.db
    .update(processedPosts)
    .set({ status: 'published', rejectionReason: null, rejectionNote: null, updatedAt: new Date() })
    .where(and(eq(processedPosts.id, draft.processedPostId), eq(processedPosts.status, 'rejected')));
  await refreshControl(context, draft);
  return draft;
}

/**
 * The post was edited in the draft channel. Noted on the control message the
 * first time, so the reviewer sees the edit was seen; the copy taken when it
 * goes picks the edit up by itself.
 */
export async function noteDraftEdit(
  context: DraftsContext,
  input: { chatId: string; messageId: number; at?: Date },
): Promise<ChannelDraft | null> {
  const [found] = await context.db
    .select()
    .from(channelDrafts)
    .where(
      and(
        eq(channelDrafts.draftChatId, input.chatId),
        rawSql`${input.messageId} = any(${channelDrafts.messageIds})`,
        inArray(channelDrafts.status, ['waiting', 'scheduled']),
      ),
    )
    .limit(1);
  if (!found) return null;
  const [draft] = await context.db
    .update(channelDrafts)
    .set({ editedAt: input.at ?? new Date(), updatedAt: new Date() })
    .where(eq(channelDrafts.id, found.id))
    .returning();
  // The note shows from the first edit on; later ones change nothing on screen.
  if (draft && found.editedAt === null) await refreshControl(context, draft);
  return draft ?? null;
}

/**
 * Sends a draft on to its channel: a copy of its messages there as they are
 * now. Claimed first, so a double tap, or a tap in the minute it is due, sends
 * it once. On failure it goes back to how it was, with the error on its
 * control message; from the schedule, it is tried again next minute, and after
 * MAX_RETRY_ATTEMPTS it waits for the reviewer instead.
 */
export async function publishDraft(
  context: DraftsContext & { env: Pick<Env, 'TELEGRAM_DISABLE_NOTIFICATION' | 'MAX_RETRY_ATTEMPTS'> },
  input: { id: number; due?: Date },
): Promise<{ ok: true; draft: ChannelDraft } | { ok: false; draft: ChannelDraft | null; error: string | null }> {
  const { db, client, logger } = context;
  const fromSchedule = input.due !== undefined;
  const claimed = fromSchedule
    ? await transition(db, input.id, ['scheduled'], { status: 'publishing' }, lte(channelDrafts.scheduledFor, input.due!))
    : await transition(db, input.id, ['waiting', 'scheduled'], { status: 'publishing' });
  if (!claimed) return { ok: false, draft: await findDraft(db, input.id), error: null };
  const before: DraftStatus = claimed.scheduledFor ? 'scheduled' : 'waiting';
  await refreshControl(context, claimed);

  try {
    const [workspace] = await db
      .select({ chatId: workspaces.telegramChatId })
      .from(workspaces)
      .where(eq(workspaces.id, claimed.workspaceId))
      .limit(1);
    if (!workspace?.chatId) throw new Error('the channel has no Telegram channel to publish to');
    if (workspace.chatId === claimed.draftChatId) throw new Error('the draft channel is the channel itself');

    const copies = await client.copyMessages({
      chatId: workspace.chatId,
      fromChatId: claimed.draftChatId,
      messageIds: claimed.messageIds,
      disableNotification: context.env.TELEGRAM_DISABLE_NOTIFICATION,
    });
    const copyIds = copies.map((copy) => copy.message_id);
    const now = new Date();

    const published = await db.transaction(async (tx) => {
      const [done] = await tx
        .update(channelDrafts)
        .set({ status: 'published', publishedChatId: workspace.chatId, publishedMessageIds: copyIds, publishedAt: now, error: null, updatedAt: now })
        .where(eq(channelDrafts.id, claimed.id))
        .returning();
      // The post's record points at the channel's copy from now on.
      const drafted = await tx
        .select({ kind: telegramMessages.kind, mediaIndex: telegramMessages.mediaIndex })
        .from(telegramMessages)
        .where(and(eq(telegramMessages.processedPostId, claimed.processedPostId), eq(telegramMessages.telegramChatId, claimed.draftChatId)))
        .orderBy(asc(telegramMessages.telegramMessageId));
      await tx
        .update(processedPosts)
        .set({ telegramChatId: workspace.chatId, telegramMessageId: copyIds[0] ?? null, updatedAt: now })
        .where(eq(processedPosts.id, claimed.processedPostId));
      if (copyIds.length > 0) {
        await tx.insert(telegramMessages).values(
          copyIds.map((messageId, index) => ({
            processedPostId: claimed.processedPostId,
            telegramMessageId: messageId,
            telegramChatId: workspace.chatId!,
            mediaIndex: drafted[index]?.mediaIndex ?? null,
            kind: drafted[index]?.kind ?? 'media',
          })),
        );
      }
      return done!;
    });

    logger.info('draft.published', { draftId: claimed.id, postId: claimed.processedPostId, messageIds: copyIds, fromSchedule });
    await refreshControl(context, published);
    return { ok: true, draft: published };
  } catch (error) {
    const message = describeError(error);
    const attempts = claimed.attempts + (fromSchedule ? 1 : 0);
    const giveUp = fromSchedule && attempts >= context.env.MAX_RETRY_ATTEMPTS;
    const [back] = await db
      .update(channelDrafts)
      .set({
        status: giveUp ? 'waiting' : before,
        ...(giveUp ? { scheduledFor: null } : {}),
        attempts: giveUp ? 0 : attempts,
        error: giveUp ? `Publishing failed ${attempts} times: ${message}` : `Publishing failed: ${message}`,
        updatedAt: new Date(),
      })
      .where(eq(channelDrafts.id, claimed.id))
      .returning();
    logger.error('draft.publish_failed', { draftId: claimed.id, attempts, giveUp, error: message });
    if (back) await refreshControl(context, back);
    return { ok: false, draft: back ?? null, error: message };
  }
}

export interface DraftsRunSummary {
  due: number;
  published: number;
  failed: number;
  /** Control messages sent now, after failing to go out with their post. */
  controlsSent: number;
}

/** Every scheduled draft whose time has come, and any control message still unsent. Run every minute. */
export async function publishDueDrafts(
  context: DraftsContext & { env: Pick<Env, 'TELEGRAM_DISABLE_NOTIFICATION' | 'MAX_RETRY_ATTEMPTS'>; now?: Date },
): Promise<DraftsRunSummary> {
  const now = context.now ?? new Date();
  const summary: DraftsRunSummary = { due: 0, published: 0, failed: 0, controlsSent: 0 };

  const due = await context.db
    .select({ id: channelDrafts.id })
    .from(channelDrafts)
    .where(and(eq(channelDrafts.status, 'scheduled'), lte(channelDrafts.scheduledFor, now)))
    .orderBy(asc(channelDrafts.scheduledFor))
    .limit(DRAFTS_PER_RUN);
  summary.due = due.length;
  for (const { id } of due) {
    const result = await publishDraft({ ...context, logger: context.logger.child({ draftId: id }) }, { id, due: now });
    if (result.ok) summary.published += 1;
    else if (result.error) summary.failed += 1;
  }

  const unsent = await context.db
    .select()
    .from(channelDrafts)
    .where(
      and(
        isNull(channelDrafts.controlMessageId),
        inArray(channelDrafts.status, ['waiting', 'scheduled']),
        lte(channelDrafts.createdAt, new Date(now.getTime() - CONTROL_RETRY_AFTER_MS)),
      ),
    )
    .limit(DRAFTS_PER_RUN);
  for (const draft of unsent) {
    try {
      await sendControl(context, draft);
      summary.controlsSent += 1;
    } catch (error) {
      context.logger.warn('draft.control_failed', { draftId: draft.id, error: describeError(error) });
    }
  }
  return summary;
}
