import { payloadMediaCount, type ApprovalPayload, type ProcessedPost } from '@/db/schema';
import type { Database } from '@/lib/db';
import type { Env } from '@/lib/env';
import { createLogger, type Logger } from '@/lib/logger';
import { acquireMedia } from '@/lib/sync/acquire-media';
import type { TelegramClient } from '@/lib/telegram/client';
import type { TelegramDestination } from '@/lib/workspace';
import { publishApprovedPayload, type PublishResult } from '@/lib/sync/approval';
import { markPublished } from '@/lib/sync/repository';

/**
 * Send a decided post to its channel and record it as published.
 *
 * The one path for Approve, Publish now, the review queue and the scheduler
 * alike, so they cannot drift apart on what gets sent. The caller has already
 * claimed the post; on failure this throws and the caller decides where it
 * goes back to.
 *
 * A post reviewed in the chat is re-sent from Telegram's own copies. One from
 * the review queue never was sent, so its media are fetched again from X now,
 * all of them before anything is sent — the same all-or-nothing as the first
 * time. A post X has since deleted therefore fails here, and stays undecided.
 */
export async function publishDecidedPost(input: {
  db: Database;
  env: Env;
  client: TelegramClient;
  row: ProcessedPost;
  payload: ApprovalPayload;
  destination: TelegramDestination;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  /** When a person approved it now; omitted when the decision was made earlier. */
  reviewedAt?: Date;
}): Promise<PublishResult> {
  // The caption column, not the payload's copy, is what gets published: it is
  // the one an edit is guaranteed to have written. The fallback covers a post
  // queued before the column existed.
  const payload = { ...input.payload, caption: input.row.caption ?? input.payload.caption };

  const media =
    payload.items.length === 0 && payload.sourceMedia?.length
      ? await acquireMedia(payload.sourceMedia, {
          env: input.env,
          logger: input.logger ?? createLogger({ app: 'content-arbitrary' }),
          fetchImpl: input.fetchImpl,
        })
      : undefined;

  const result = await publishApprovedPayload(
    {
      client: input.client,
      chatId: input.destination.chatId,
      disableNotification: input.destination.disableNotification,
    },
    payload,
    { logger: input.logger, media },
  );

  await markPublished(input.db, {
    id: input.row.id,
    telegramChatId: input.destination.chatId,
    primaryMessageId: result.primaryMessageId,
    telegramMethod: result.method,
    mediaCount: payloadMediaCount(payload),
    messages: result.messages,
    reviewedAt: input.reviewedAt,
  });

  return result;
}
