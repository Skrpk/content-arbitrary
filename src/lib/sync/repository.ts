import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql as rawSql } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import {
  DEFAULT_WORKSPACE_ID,
  processedPosts,
  syncState,
  telegramMessages,
  type ApprovalPayload,
  type PostStatus,
  type RejectionReason,
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
    | 'scheduled'
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
    /** The author's full text, kept for analysis whatever becomes of the post. */
    sourceText?: string | null;
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
      sourceText: input.sourceText ?? null,
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
        // Filled in once, for a row first seen before the column existed;
        // otherwise what was recorded the first time stands.
        sourceText: rawSql`coalesce(${processedPosts.sourceText}, ${input.sourceText ?? null})`,
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
  if (current.status === 'scheduled') return { claimed: false, row: current, reason: 'scheduled' };
  if (current.status === 'skipped') return { claimed: false, row: current, reason: 'permanently-failed' };
  if (current.status === 'failed') return { claimed: false, row: current, reason: 'retries-exhausted' };
  return { claimed: false, row: current, reason: 'in-flight' };
}

/**
 * Copy the caption out of the review payload before a decision drops it.
 *
 * A no-op for posts queued by this code, which already have both columns. It
 * exists for posts queued by the previous deploy in the window between the
 * migration and the new code going live: without it their text would vanish
 * along with the payload. Postgres evaluates SET against the row as it was, so
 * this reads the payload even though the same UPDATE clears it.
 */
const keepCaptionsFromPayload = {
  originalCaption: rawSql`coalesce(${processedPosts.originalCaption}, ${processedPosts.approvalPayload}->>'caption')`,
  caption: rawSql`coalesce(${processedPosts.caption}, ${processedPosts.approvalPayload}->>'caption')`,
};

/** A post's status, as seen from one tenant; undefined for another tenant's post. */
export async function findStatusInWorkspace(
  db: Database,
  input: { id: number; workspaceId: number },
): Promise<PostStatus | undefined> {
  const rows = await db
    .select({ status: processedPosts.status })
    .from(processedPosts)
    .where(and(eq(processedPosts.id, input.id), eq(processedPosts.workspaceId, input.workspaceId)))
    .limit(1);

  return rows[0]?.status;
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
    /** When the reviewer approved it; omitted for a post published with no review. */
    reviewedAt?: Date;
    /**
     * The caption a post published with no review went out with. A reviewed
     * post already carries its captions, and they take precedence.
     */
    caption?: string;
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
        originalCaption: rawSql`coalesce(${processedPosts.originalCaption}, ${processedPosts.approvalPayload}->>'caption', ${input.caption ?? null})`,
        caption: rawSql`coalesce(${processedPosts.caption}, ${processedPosts.approvalPayload}->>'caption', ${input.caption ?? null})`,
        ...(input.reviewedAt ? { reviewedAt: input.reviewedAt } : {}),
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

/**
 * Park a post in the reviewer's queue, keeping everything needed to publish it.
 *
 * The captions are only ever filled in, never replaced: should a post somehow
 * be queued a second time, its original stays the one first reviewed and a
 * reviewer's edit is not thrown away.
 */
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
      originalCaption: rawSql`coalesce(${processedPosts.originalCaption}, ${input.payload.caption})`,
      caption: rawSql`coalesce(${processedPosts.caption}, ${input.payload.caption})`,
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
  workspaceId: number = DEFAULT_WORKSPACE_ID,
  /** Which states a decision may be taken from: Publish now also takes a scheduled post. */
  from: PostStatus[] = ['awaiting_approval'],
): Promise<{ claimed: boolean; row?: typeof processedPosts.$inferSelect; currentStatus?: PostStatus }> {
  const rows = await db
    .update(processedPosts)
    .set({ status: 'processing', lockedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(processedPosts.id, postId),
        // Scoped to the presser's own tenant: a callback carries only a post id,
        // so without this one reviewer could publish another tenant's post by
        // sending a button press for an id that was never theirs.
        eq(processedPosts.workspaceId, workspaceId),
        inArray(processedPosts.status, from),
      ),
    )
    .returning();

  const row = rows[0];
  if (row) return { claimed: true, row };

  // Scoped like the claim, so a foreign id does not reveal how that post ended.
  return { claimed: false, currentStatus: await findStatusInWorkspace(db, { id: postId, workspaceId }) };
}

/**
 * A post a reviewer is allowed to look at or edit.
 *
 * Scoped to their tenant and limited to `awaiting_approval`: a published or
 * rejected post is settled, and editing it would promise a change that can
 * never reach the channel.
 */
export async function findPostAwaitingReview(
  db: Database,
  input: {
    id: number;
    workspaceId: number;
    /** Also a post approved for later, which can still be edited or retimed. */
    includeScheduled?: boolean;
  },
) {
  const rows = await db
    .select()
    .from(processedPosts)
    .where(
      and(
        eq(processedPosts.id, input.id),
        eq(processedPosts.workspaceId, input.workspaceId),
        inArray(processedPosts.status, openStatuses(input.includeScheduled)),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/** States in which a post has not gone out and can still be changed. */
function openStatuses(includeScheduled = false): PostStatus[] {
  return includeScheduled ? ['awaiting_approval', 'scheduled'] : ['awaiting_approval'];
}

/**
 * Replace the caption an approved post will be published with.
 *
 * One guarded UPDATE, for the same reason the approval claim is one: the
 * reviewer may be pressing Approve in the chat while the Mini App is open, and
 * an edit must not land on a post that has already left the queue.
 *
 * The overflow follow-up is dropped. It held the untruncated original, which a
 * hand-written caption contradicts rather than completes.
 *
 * `original_caption` is never written here — every edit, however many, is
 * measured against what was first reviewed. The only exception fills it in for
 * a post queued before the column existed, from the payload's caption as it
 * stood before this edit.
 */
export async function updateApprovalCaption(
  db: Database,
  input: { id: number; workspaceId: number; caption: string },
): Promise<{
  updated: boolean;
  currentStatus?: PostStatus;
  /** The reviewer's preview of the follow-up this edit dropped, if there was one. */
  droppedOverflowPreviewId?: number;
}> {
  // A scheduled post is still unpublished, so its text may still change.
  const existing = await findPostAwaitingReview(db, { ...input, includeScheduled: true });
  if (!existing || !existing.approvalPayload) {
    return { updated: false, currentStatus: await findStatusInWorkspace(db, input) };
  }

  const payload: ApprovalPayload = {
    ...existing.approvalPayload,
    caption: input.caption,
    overflowMessage: undefined,
    adminOverflowMessageId: undefined,
  };

  const rows = await db
    .update(processedPosts)
    .set({
      approvalPayload: payload,
      originalCaption: rawSql`coalesce(${processedPosts.originalCaption}, ${existing.approvalPayload.caption})`,
      caption: input.caption,
      captionEditedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(processedPosts.id, input.id),
        eq(processedPosts.workspaceId, input.workspaceId),
        inArray(processedPosts.status, openStatuses(true)),
      ),
    )
    .returning({ id: processedPosts.id });

  return rows.length > 0
    ? { updated: true, droppedOverflowPreviewId: existing.approvalPayload.adminOverflowMessageId }
    : { updated: false, currentStatus: existing.status };
}

/**
 * Approve a post for publishing at a later time, or move the time of one
 * already scheduled.
 *
 * One guarded UPDATE, like every decision: it races Approve, Reject and the
 * scheduler itself safely, because each needs the post in a state this
 * changes. The review time is the first decision's; retiming does not move it.
 */
export async function schedulePost(
  db: Database,
  input: { id: number; workspaceId: number; scheduledFor: Date; timezone: string },
): Promise<{ scheduled: boolean; row?: typeof processedPosts.$inferSelect; currentStatus?: PostStatus }> {
  const rows = await db
    .update(processedPosts)
    .set({
      status: 'scheduled',
      scheduledFor: input.scheduledFor,
      scheduledTimezone: input.timezone,
      reviewedAt: rawSql`CASE WHEN ${processedPosts.status} = 'awaiting_approval' THEN now() ELSE ${processedPosts.reviewedAt} END`,
      // A fresh count for the scheduler's own attempts.
      retryCount: 0,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(processedPosts.id, input.id),
        eq(processedPosts.workspaceId, input.workspaceId),
        inArray(processedPosts.status, openStatuses(true)),
      ),
    )
    .returning();

  const row = rows[0];
  if (row) return { scheduled: true, row };
  return { scheduled: false, currentStatus: await findStatusInWorkspace(db, input) };
}

/** Take a scheduled post back into the review queue, undoing the decision. */
export async function unschedulePost(
  db: Database,
  input: { id: number; workspaceId: number },
): Promise<{ unscheduled: boolean; row?: typeof processedPosts.$inferSelect; currentStatus?: PostStatus }> {
  const rows = await db
    .update(processedPosts)
    .set({
      status: 'awaiting_approval',
      scheduledFor: null,
      scheduledTimezone: null,
      reviewedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(processedPosts.id, input.id),
        eq(processedPosts.workspaceId, input.workspaceId),
        eq(processedPosts.status, 'scheduled'),
      ),
    )
    .returning();

  const row = rows[0];
  if (row) return { unscheduled: true, row };
  return { unscheduled: false, currentStatus: await findStatusInWorkspace(db, input) };
}

/** Ids of scheduled posts whose time has come, earliest first. */
export async function listDueScheduledPostIds(
  db: Database,
  input: { now: Date; limit: number },
): Promise<number[]> {
  const rows = await db
    .select({ id: processedPosts.id })
    .from(processedPosts)
    .where(and(eq(processedPosts.status, 'scheduled'), lte(processedPosts.scheduledFor, input.now)))
    .orderBy(asc(processedPosts.scheduledFor), asc(processedPosts.id))
    .limit(input.limit);
  return rows.map((row) => row.id);
}

/**
 * Take a due post for publishing.
 *
 * Conditional on it still being scheduled and due, so two overlapping
 * scheduler runs — or a Publish now pressed at the same minute — publish it
 * exactly once, and a post retimed or cancelled a moment ago is left alone.
 */
export async function claimScheduledForPublishing(
  db: Database,
  input: { id: number; now: Date },
): Promise<typeof processedPosts.$inferSelect | null> {
  const rows = await db
    .update(processedPosts)
    .set({ status: 'processing', lockedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(processedPosts.id, input.id),
        eq(processedPosts.status, 'scheduled'),
        lte(processedPosts.scheduledFor, input.now),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Put a post back on the schedule after a failed publish, counting the
 * attempt when it was the scheduler's, so a lasting failure is noticed.
 */
export async function returnToSchedule(
  db: Database,
  input: { id: number; errorMessage: string; countAttempt: boolean },
): Promise<number> {
  const rows = await db
    .update(processedPosts)
    .set({
      status: 'scheduled',
      errorMessage: input.errorMessage.slice(0, 2000),
      retryCount: input.countAttempt
        ? rawSql`${processedPosts.retryCount} + 1`
        : processedPosts.retryCount,
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(processedPosts.id, input.id))
    .returning({ retryCount: processedPosts.retryCount });
  return rows[0]?.retryCount ?? 0;
}

/**
 * Give up on a schedule that keeps failing: back to the review queue, with
 * the error, so the reviewer decides again rather than the scheduler trying
 * forever.
 */
export async function abandonSchedule(
  db: Database,
  input: { id: number; errorMessage: string },
): Promise<void> {
  await db
    .update(processedPosts)
    .set({
      status: 'awaiting_approval',
      errorMessage: input.errorMessage.slice(0, 2000),
      scheduledFor: null,
      scheduledTimezone: null,
      reviewedAt: null,
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(processedPosts.id, input.id));
}

/** A tenant's scheduled posts, soonest first. */
export async function listScheduledPosts(db: Database, workspaceId: number) {
  return db
    .select()
    .from(processedPosts)
    .where(and(eq(processedPosts.workspaceId, workspaceId), eq(processedPosts.status, 'scheduled')))
    .orderBy(asc(processedPosts.scheduledFor), asc(processedPosts.id));
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

/**
 * Turn a post down, recording why.
 *
 * Settles the post in one guarded UPDATE straight from `awaiting_approval`,
 * with no intermediate state: a second tap, a stale button, or a reason chosen
 * after Approve already won all find the status changed and write nothing, so
 * a recorded decision is never overwritten.
 */
export async function rejectWithReason(
  db: Database,
  input: {
    id: number;
    workspaceId: number;
    reason: RejectionReason;
    /** The reviewer's own words; plain text, empty treated as none. */
    note?: string | null;
  },
): Promise<{ rejected: boolean; row?: typeof processedPosts.$inferSelect; currentStatus?: PostStatus }> {
  const rows = await db
    .update(processedPosts)
    .set({
      status: 'rejected',
      rejectionReason: input.reason,
      rejectionNote: input.note?.trim() || null,
      ...keepCaptionsFromPayload,
      // The payload only exists to publish with; drop it once we never will.
      approvalPayload: null,
      reviewedAt: new Date(),
      processedAt: new Date(),
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(processedPosts.id, input.id),
        eq(processedPosts.workspaceId, input.workspaceId),
        eq(processedPosts.status, 'awaiting_approval'),
      ),
    )
    .returning();

  const row = rows[0];
  if (row) return { rejected: true, row };

  return { rejected: false, currentStatus: await findStatusInWorkspace(db, input) };
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

/**
 * Attach historical posts to a source that has just been registered.
 *
 * The 0003 migration back-fills `source_id` by matching the stored author
 * handle, but it can only match sources that already existed. A source imported
 * from the legacy environment is created after that migration has run, so its
 * own history would stay unattributed without this.
 *
 * Matching on the handle is safe here precisely because it is historical: these
 * rows record what the account was called when the post was published.
 */
export async function attributePostsToSource(
  db: Database,
  input: { sourceId: number; username: string; workspaceId?: number },
): Promise<number> {
  const rows = await db
    .update(processedPosts)
    .set({ sourceId: input.sourceId })
    .where(
      and(
        eq(processedPosts.workspaceId, input.workspaceId ?? DEFAULT_WORKSPACE_ID),
        isNull(processedPosts.sourceId),
        rawSql`lower(${processedPosts.xAuthorUsername}) = lower(${input.username})`,
      ),
    )
    .returning({ id: processedPosts.id });

  return rows.length;
}

export async function getSyncState(
  db: Database,
  source: string,
  workspaceId: number = DEFAULT_WORKSPACE_ID,
) {
  const rows = await db
    .select()
    .from(syncState)
    .where(and(eq(syncState.workspaceId, workspaceId), eq(syncState.source, source)))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertSyncState(
  db: Database,
  input: {
    source: string;
    workspaceId?: number;
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
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      source: input.source,
      lastSeenPostId: input.lastSeenPostId ?? null,
      lastSyncAt: input.lastSyncAt ?? null,
      lastSuccessfulSyncAt: input.lastSuccessfulSyncAt ?? null,
      lastError: input.lastError ?? null,
    })
    .onConflictDoUpdate({ target: [syncState.workspaceId, syncState.source], set });
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
    scheduled: 0,
  };
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}
