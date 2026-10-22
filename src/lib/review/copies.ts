import { asc, eq } from 'drizzle-orm';
import { reviewCopies } from '@/db/schema';
import type { Database } from '@/lib/db';
import type { Logger } from '@/lib/logger';
import { settleReviewMessage } from '@/lib/sync/approval';
import type { TelegramClient } from '@/lib/telegram/client';

/**
 * A post goes to review in every reviewer's private chat, so it has one review
 * message per reviewer. Each is a copy: its own media preview, overflow text and
 * buttons. The post's own copy is `processed_posts.admin_chat_id` and
 * `admin_message_id`; the others are `review_copies` rows. A decision — approve,
 * reject, schedule, edit — is made once and applies to every copy.
 */

/** One reviewer's review message for a post. */
export interface ReviewCopy {
  /** The reviewer's private chat — their Telegram user id. */
  chatId: string;
  /** The message carrying the buttons. */
  controlMessageId: number;
  mediaMessageId?: number;
  overflowMessageId?: number;
}

/** Every review message a post has, the post's own first. Empty for a queued post. */
export async function reviewCopiesOf(
  db: Database,
  post: {
    id: number;
    adminChatId: string | null;
    adminMessageId: number | null;
    approvalPayload?: {
      adminMediaMessageId?: number;
      adminOverflowMessageId?: number;
    } | null;
  },
): Promise<ReviewCopy[]> {
  const copies: ReviewCopy[] = [];

  if (post.adminChatId && post.adminMessageId) {
    copies.push({
      chatId: post.adminChatId,
      controlMessageId: post.adminMessageId,
      mediaMessageId: post.approvalPayload?.adminMediaMessageId,
      overflowMessageId: post.approvalPayload?.adminOverflowMessageId,
    });
  }

  const others = await db
    .select()
    .from(reviewCopies)
    .where(eq(reviewCopies.processedPostId, post.id))
    .orderBy(asc(reviewCopies.createdAt));
  for (const row of others) {
    copies.push({
      chatId: row.chatId,
      controlMessageId: row.controlMessageId,
      mediaMessageId: row.mediaMessageId ?? undefined,
      overflowMessageId: row.overflowMessageId ?? undefined,
    });
  }

  return copies;
}

/** Keeps the copies a review went out in beyond the post's own. */
export async function recordReviewCopies(db: Database, processedPostId: number, copies: ReviewCopy[]): Promise<void> {
  if (copies.length === 0) return;
  await db
    .insert(reviewCopies)
    .values(
      copies.map((copy) => ({
        processedPostId,
        chatId: copy.chatId,
        controlMessageId: copy.controlMessageId,
        mediaMessageId: copy.mediaMessageId ?? null,
        overflowMessageId: copy.overflowMessageId ?? null,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Replaces the text of every copy's buttons message, and takes the buttons away.
 * One reviewer's chat failing must not stop the others from being settled.
 */
export async function settleAllReviewMessages(
  client: TelegramClient,
  copies: ReviewCopy[],
  note: string,
  logger?: Logger,
): Promise<void> {
  for (const copy of copies) {
    try {
      await settleReviewMessage(client, copy.chatId, copy.controlMessageId, note);
    } catch (error) {
      logger?.warn('review.copy_settle_failed', {
        chatId: copy.chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
