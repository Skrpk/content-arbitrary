import { and, desc, eq, inArray, lt, or, sql as rawSql } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import {
  DEFAULT_WORKSPACE_ID,
  processedPosts,
  syncState,
  telegramMessages,
  type ApprovalPayload,
  type PostStatus,
} from '@/db/schema';

/**
 * All database access for the sync pipeline lives here, so the idempotency
 * rules are enforced in exactly one place.
 */

/**
 * How long a row may sit in `processing` before we assume the invocation that
 * claimed it was killed (Vercel hard-stops a function at its maxDuration) and
 * allow another run to pick it up.
 */
export const PROCESSING_LEASE_MS = 10 * 60 * 1000;

export interface ClaimResult {
  claimed: boolean;
  row?: typeof processedPosts.$inferSelect;
  reason?:
    | 'already-published'
    | 'in-flight'
    | 'retries-exhausted'
    | 'permanently-failed'
    | 'awaiting-approval'
    | 'rejected';
}

/**
 * Atomically take ownership of a post.
 *
 * This is the core of the duplicate protection. The INSERT relies on the UNIQUE
 * index on `x_post_id`:
 *
 *   - if no row exists, we insert one directly in `processing` state and win;
 *   - if a row already exists, `ON CONFLICT ... DO UPDATE` only flips it to
 *     `processing` when it is genuinely eligible (pending, or a failed row with
 *     retries left, or a stale lease). Otherwise the WHERE clause suppresses the
 *     update and no row is returned, so the caller knows it did not win.
 *
 * Because the whole decision is one statement, two concurrent invocations can
 * never both observe "not yet published" and both proceed.
 */
export async function claimPost(
  db: Database,
  input: {
    xPostId: string;
    xPostUrl: string;
    xAuthorUsername: string | null;
    xCreatedAt: Date | null;
    maxRetryAttempts: number;
    /** Which source produced it; null for rows that predate source tracking. */
    sourceId?: number | null;
    workspaceId?: number;
  },
): Promise<ClaimResult> {
  const staleBefore = new Date(Date.now() - PROCESSING_LEASE_MS);
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;

  const rows = await db
    .insert(processedPosts)
    .values({
      workspaceId,
      sourceId: input.sourceId ?? null,
      xPostId: input.xPostId,
      xPostUrl: input.xPostUrl,
      xAuthorUsername: input.xAuthorUsername,
      xCreatedAt: input.xCreatedAt,
      status: 'processing',
      lockedAt: new Date(),
    })
    .onConflictDoUpdate({
      // Scoped to the workspace, matching the UNIQUE index: the same post may
      // legitimately exist once per tenant.
      target: [processedPosts.workspaceId, processedPosts.xPostId],
      set: {
        status: 'processing',
        sourceId: input.sourceId ?? null,
        lockedAt: new Date(),
        updatedAt: new Date(),
      },
      where: or(
        eq(processedPosts.status, 'pending'),
        and(
          eq(processedPosts.status, 'failed'),
          lt(processedPosts.retryCount, input.maxRetryAttempts),
        ),
        // Reclaim an abandoned lease from a function that was killed mid-run.
        and(
          eq(processedPosts.status, 'processing'),
          lt(processedPosts.lockedAt, staleBefore),
        ),
      ),
    })
    .returning();

  const row = rows[0];
  if (row) return { claimed: true, row };

  // We did not win the claim — report why, for accurate run accounting.
  const existing = await db
    .select()
    .from(processedPosts)
    .where(
      and(
        eq(processedPosts.workspaceId, workspaceId),
        eq(processedPosts.xPostId, input.xPostId),
      ),
    )
    .limit(1);

  const current = existing[0];
  if (!current) return { claimed: false, reason: 'in-flight' };
  if (current.status === 'published') return { claimed: false, row: current, reason: 'already-published' };
  if (current.status === 'awaiting_approval') return { claimed: false, row: current, reason: 'awaiting-approval' };
  if (current.status === 'rejected') return { claimed: false, row: current, reason: 'rejected' };
  if (current.status === 'skipped') return { claimed: false, row: current, reason: 'permanently-failed' };
  if (current.status === 'failed') return { claimed: false, row: current, reason: 'retries-exhausted' };
  return { claimed: false, row: current, reason: 'in-flight' };
}

export async function markPublished(
  db: Database,
  input: {
    id: number;
    telegramChatId: string;
    primaryMessageId: number | null;
    telegramMethod: string;
    mediaCount: number;
    messages: { messageId: number; mediaIndex: number | null; kind: string }[];
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(processedPosts)
      .set({
        status: 'published',
        telegramChatId: input.telegramChatId,
        telegramMessageId: input.primaryMessageId,
        telegramMethod: input.telegramMethod,
        mediaCount: input.mediaCount,
        errorMessage: null,
        approvalPayload: null,
        processedAt: new Date(),
        updatedAt: new Date(),
        lockedAt: null,
      })
      .where(eq(processedPosts.id, input.id));

    if (input.messages.length > 0) {
      await tx.insert(telegramMessages).values(
        input.messages.map((message) => ({
          processedPostId: input.id,
          telegramMessageId: message.messageId,
          telegramChatId: input.telegramChatId,
          mediaIndex: message.mediaIndex,
          kind: message.kind,
        })),
      );
    }
  });
}

/** Park a post in the reviewer's queue, keeping everything needed to publish it. */
export async function markAwaitingApproval(
  db: Database,
  input: {
    id: number;
    payload: ApprovalPayload;
    adminChatId: string;
    adminMessageId: number;
  },
): Promise<void> {
  await db
    .update(processedPosts)
    .set({
      status: 'awaiting_approval',
      approvalPayload: input.payload,
      adminChatId: input.adminChatId,
      adminMessageId: input.adminMessageId,
      telegramMethod: input.payload.method,
      mediaCount: input.payload.items.length,
      errorMessage: null,
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(processedPosts.id, input.id));
}

/**
 * Take exclusive ownership of a post awaiting review.
 *
 * The status change is the guard: a single conditional UPDATE means that two
 * taps on Approve — or an Approve and a Reject racing each other — produce
 * exactly one winner, and the loser gets no row back. Without this, an
 * impatient double-tap would publish the album twice.
 */
export async function claimForDecision(
  db: Database,
  postId: number,
): Promise<{ claimed: boolean; row?: typeof processedPosts.$inferSelect; currentStatus?: PostStatus }> {
  const rows = await db
    .update(processedPosts)
    .set({ status: 'processing', lockedAt: new Date(), updatedAt: new Date() })
    .where(
      and(eq(processedPosts.id, postId), eq(processedPosts.status, 'awaiting_approval')),
    )
    .returning();

  const row = rows[0];
  if (row) return { claimed: true, row };

  const existing = await db
    .select()
    .from(processedPosts)
    .where(eq(processedPosts.id, postId))
    .limit(1);

  return { claimed: false, currentStatus: existing[0]?.status };
}

/** Put a post back in the queue when publishing failed after a decision. */
export async function releaseToApproval(
  db: Database,
  input: { id: number; errorMessage: string },
): Promise<void> {
  await db
    .update(processedPosts)
    .set({
      status: 'awaiting_approval',
      errorMessage: input.errorMessage.slice(0, 2000),
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(processedPosts.id, input.id));
}

export async function markRejected(db: Database, postId: number): Promise<void> {
  await db
    .update(processedPosts)
    .set({
      status: 'rejected',
      // The payload only exists to publish with; drop it once we never will.
      approvalPayload: null,
      reviewedAt: new Date(),
      processedAt: new Date(),
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(processedPosts.id, postId));
}

export async function markFailed(
  db: Database,
  input: { id: number; errorMessage: string; permanent: boolean; maxRetryAttempts: number },
): Promise<PostStatus> {
  // `skipped` means "we will never publish this" (unsupported media, file too
  // large). `failed` with retries left will be retried on the next cron run.
  const nextStatus: PostStatus = input.permanent ? 'skipped' : 'failed';

  const rows = await db
    .update(processedPosts)
    .set({
      status: nextStatus,
      errorMessage: input.errorMessage.slice(0, 2000),
      retryCount: input.permanent
        ? processedPosts.retryCount
        : rawSql`${processedPosts.retryCount} + 1`,
      processedAt: new Date(),
      updatedAt: new Date(),
      lockedAt: null,
    })
    .where(eq(processedPosts.id, input.id))
    .returning({ retryCount: processedPosts.retryCount });

  const retryCount = rows[0]?.retryCount ?? 0;

  // Out of retries: stop trying forever, but keep the last error for /api/status.
  if (!input.permanent && retryCount >= input.maxRetryAttempts) {
    await db
      .update(processedPosts)
      .set({ status: 'skipped', updatedAt: new Date() })
      .where(eq(processedPosts.id, input.id));
    return 'skipped';
  }

  return nextStatus;
}

/** Dry-run outcome: remember what we learned, but leave it unpublished. */
export async function markPending(
  db: Database,
  input: { id: number; telegramMethod: string; mediaCount: number },
): Promise<void> {
  await db
    .update(processedPosts)
    .set({
      status: 'pending',
      telegramMethod: input.telegramMethod,
      mediaCount: input.mediaCount,
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(processedPosts.id, input.id));
}

export async function markSkipped(
  db: Database,
  input: { id: number; reason: string },
): Promise<void> {
  await db
    .update(processedPosts)
    .set({
      status: 'skipped',
      errorMessage: input.reason.slice(0, 2000),
      processedAt: new Date(),
      updatedAt: new Date(),
      lockedAt: null,
    })
    .where(eq(processedPosts.id, input.id));
}

/** Post ids we have already reached a terminal decision on. */
export async function findTerminalPostIds(
  db: Database,
  xPostIds: string[],
  workspaceId: number = DEFAULT_WORKSPACE_ID,
): Promise<Set<string>> {
  if (xPostIds.length === 0) return new Set();

  const rows = await db
    .select({ xPostId: processedPosts.xPostId })
    .from(processedPosts)
    .where(
      and(
        eq(processedPosts.workspaceId, workspaceId),
        inArray(processedPosts.xPostId, xPostIds),
        inArray(processedPosts.status, ['published', 'skipped', 'rejected']),
      ),
    );

  return new Set(rows.map((row) => row.xPostId));
}

export async function getSyncState(db: Database, source: string) {
  const rows = await db.select().from(syncState).where(eq(syncState.source, source)).limit(1);
  return rows[0] ?? null;
}

export async function upsertSyncState(
  db: Database,
  input: {
    source: string;
    lastSeenPostId?: string | null;
    lastSyncAt?: Date;
    lastSuccessfulSyncAt?: Date | null;
    lastError?: string | null;
  },
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.lastSeenPostId !== undefined) set.lastSeenPostId = input.lastSeenPostId;
  if (input.lastSyncAt !== undefined) set.lastSyncAt = input.lastSyncAt;
  if (input.lastSuccessfulSyncAt !== undefined) set.lastSuccessfulSyncAt = input.lastSuccessfulSyncAt;
  if (input.lastError !== undefined) set.lastError = input.lastError;

  await db
    .insert(syncState)
    .values({
      source: input.source,
      lastSeenPostId: input.lastSeenPostId ?? null,
      lastSyncAt: input.lastSyncAt ?? null,
      lastSuccessfulSyncAt: input.lastSuccessfulSyncAt ?? null,
      lastError: input.lastError ?? null,
    })
    .onConflictDoUpdate({ target: syncState.source, set });
}

export async function getRecentPosts(db: Database, limit = 10) {
  return db
    .select({
      xPostId: processedPosts.xPostId,
      xPostUrl: processedPosts.xPostUrl,
      status: processedPosts.status,
      telegramMessageId: processedPosts.telegramMessageId,
      telegramMethod: processedPosts.telegramMethod,
      mediaCount: processedPosts.mediaCount,
      errorMessage: processedPosts.errorMessage,
      retryCount: processedPosts.retryCount,
      processedAt: processedPosts.processedAt,
      createdAt: processedPosts.createdAt,
      adminMessageId: processedPosts.adminMessageId,
      reviewedAt: processedPosts.reviewedAt,
    })
    .from(processedPosts)
    .orderBy(desc(processedPosts.createdAt))
    .limit(limit);
}

export async function getStatusCounts(db: Database) {
  const rows = await db
    .select({ status: processedPosts.status, count: rawSql<number>`count(*)::int` })
    .from(processedPosts)
    .groupBy(processedPosts.status);

  const counts: Record<PostStatus, number> = {
    pending: 0,
    processing: 0,
    published: 0,
    failed: 0,
    skipped: 0,
    awaiting_approval: 0,
    rejected: 0,
  };
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}
