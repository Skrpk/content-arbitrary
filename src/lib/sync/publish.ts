import type { ApprovalPayload, ProcessedPost } from '@/db/schema';
import type { Database } from '@/lib/db';
import type { Logger } from '@/lib/logger';
import type { TelegramClient } from '@/lib/telegram/client';
import type { TelegramDestination } from '@/lib/workspace';
import { publishApprovedPayload, type PublishResult } from '@/lib/sync/approval';
import { markPublished } from '@/lib/sync/repository';

/**
 * Send a decided post to its channel and record it as published.
 *
 * The one path for Approve, Publish now and the scheduler alike, so they
 * cannot drift apart on what gets sent. The caller has already claimed the
 * post; on failure this throws and the caller decides where it goes back to.
 */
export async function publishDecidedPost(input: {
  db: Database;
  client: TelegramClient;
  row: ProcessedPost;
  payload: ApprovalPayload;
  destination: TelegramDestination;
  logger?: Logger;
  /** When a person approved it now; omitted when the decision was made earlier. */
  reviewedAt?: Date;
}): Promise<PublishResult> {
  // The caption column, not the payload's copy, is what gets published: it is
  // the one an edit is guaranteed to have written. The fallback covers a post
  // queued before the column existed.
  const payload = { ...input.payload, caption: input.row.caption ?? input.payload.caption };

  const result = await publishApprovedPayload(
    {
      client: input.client,
      chatId: input.destination.chatId,
      disableNotification: input.destination.disableNotification,
    },
    payload,
    { logger: input.logger },
  );

  await markPublished(input.db, {
    id: input.row.id,
    telegramChatId: input.destination.chatId,
    primaryMessageId: result.primaryMessageId,
    telegramMethod: result.method,
    mediaCount: payload.items.length,
    messages: result.messages,
    reviewedAt: input.reviewedAt,
  });

  return result;
}
