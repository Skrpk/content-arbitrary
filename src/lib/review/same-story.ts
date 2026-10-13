import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import { processedPosts, storyPosts, type RejectionReason } from '@/db/schema';
import { APPROVED_STATUSES } from '@/lib/radar/repository';
import { sourceLabelOfPost } from '@/lib/sources/display';
import type { Logger } from '@/lib/logger';
import { formatRejectionNotice, settleReviewMessage } from '@/lib/sync/approval';
import { rejectWithReason } from '@/lib/sync/repository';
import type { TelegramClient } from '@/lib/telegram/client';

/**
 * The rest of a story's card, decided with the post the reviewer chose: the
 * review queue shows the waiting posts of one story as one card, and a
 * decision on it is a decision on all of them — the others rejected as
 * already covered when one is published, or with the same reason when the
 * story is turned down.
 *
 * Only the posts the reviewer was shown are decided, and only those still in
 * the same story and waiting: a post that came in since, or was decided
 * elsewhere, is left as it is.
 */

/** As many as a card can show; more is not a request the page makes. */
export const SAME_STORY_MAX = 20;

export async function rejectRestOfStory(input: {
  db: Database;
  client: TelegramClient;
  logger: Logger;
  workspaceId: number;
  /** The post the decision was made on. */
  postId: number;
  /** The other posts of its card. */
  others: number[];
  reason: RejectionReason;
  note?: string;
}): Promise<number[]> {
  const others = [...new Set(input.others)].filter((id) => id !== input.postId).slice(0, SAME_STORY_MAX);
  if (others.length === 0) return [];

  const placed = await input.db
    .select({ processedPostId: storyPosts.processedPostId, storyId: storyPosts.storyId })
    .from(storyPosts)
    .where(inArray(storyPosts.processedPostId, [input.postId, ...others]));
  const storyId = placed.find((row) => row.processedPostId === input.postId)?.storyId;
  if (storyId === undefined) return [];
  const sameStory = placed.filter((row) => row.storyId === storyId && row.processedPostId !== input.postId);

  const rejected: number[] = [];
  for (const { processedPostId } of sameStory) {
    const result = await rejectWithReason(input.db, {
      id: processedPostId,
      workspaceId: input.workspaceId,
      reason: input.reason,
      note: input.note,
    });
    if (!result.rejected || !result.row) continue;
    rejected.push(processedPostId);
    await settleReviewMessage(
      input.client,
      result.row.adminChatId,
      result.row.adminMessageId,
      formatRejectionNotice({ reason: input.reason, note: input.note ?? '', xPostUrl: result.row.xPostUrl }),
    );
  }
  input.logger.info('review.same_story_rejected', {
    postId: input.postId,
    storyId,
    reason: input.reason,
    rejected,
    left: others.filter((id) => !rejected.includes(id)),
  });
  return rejected;
}

/** Each post's story, for the posts that have one. */
export async function storiesOf(db: Database, processedPostIds: number[]): Promise<Map<number, number>> {
  if (processedPostIds.length === 0) return new Map();
  const rows = await db
    .select({ processedPostId: storyPosts.processedPostId, storyId: storyPosts.storyId })
    .from(storyPosts)
    .where(inArray(storyPosts.processedPostId, processedPostIds));
  return new Map(rows.map((row) => [row.processedPostId, row.storyId]));
}


/** What of each story the channel has already published or scheduled: by whom, and when it was approved. */
export async function publishedInStories(
  db: Database,
  workspaceId: number,
  storyIds: number[],
): Promise<Map<number, { sourceLabel: string | null; approvedAt: Date }[]>> {
  const published = new Map<number, { sourceLabel: string | null; approvedAt: Date }[]>();
  if (storyIds.length === 0) return published;
  const rows = await db
    .select({
      storyId: storyPosts.storyId,
      externalId: processedPosts.externalId,
      author: processedPosts.xAuthorUsername,
      reviewedAt: processedPosts.reviewedAt,
      createdAt: processedPosts.createdAt,
    })
    .from(storyPosts)
    .innerJoin(processedPosts, eq(processedPosts.id, storyPosts.processedPostId))
    .where(
      and(
        inArray(storyPosts.storyId, storyIds),
        eq(processedPosts.workspaceId, workspaceId),
        inArray(processedPosts.status, [...APPROVED_STATUSES]),
      ),
    )
    .orderBy(asc(processedPosts.reviewedAt));
  for (const row of rows) {
    published.set(row.storyId, [
      ...(published.get(row.storyId) ?? []),
      { sourceLabel: sourceLabelOfPost(row.externalId, row.author), approvedAt: row.reviewedAt ?? row.createdAt },
    ]);
  }
  return published;
}
