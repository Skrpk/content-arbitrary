import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql as rawSql } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import type { PostMetrics } from '@/types';
import type { RichDocument } from '@/lib/rich/document';
import {
  DEFAULT_WORKSPACE_ID,
  payloadMediaCount,
  processedPosts,
  syncState,
  telegramMessages,
  type ApprovalPayload,
  type PostStatus,
  type ReviewMediaItem,
  type RejectionReason,
  type SourceMetadata,
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
 * index on `external_id`:
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
    externalId: string;
    xPostUrl: string;
    xAuthorUsername: string | null;
    xCreatedAt: Date | null;
    maxRetryAttempts: number;
    /** Which source produced it; null for rows that predate source tracking. */
    sourceId?: number | null;
    workspaceId?: number;
    /** The author's full text, kept for analysis whatever becomes of the post. */
    sourceText?: string | null;
    /** Engagement as this fetch saw it, kept for analysis like the text. */
    metrics?: PostMetrics | null;
    /** For analysis only — a video's transcript — kept so Radar and a re-embed read what live did. */
    analysisText?: string | null;
    /** What the source said about it beyond its text. */
    sourceMetadata?: SourceMetadata | null;
  },
): Promise<ClaimResult> {
  const staleBefore = new Date(Date.now() - PROCESSING_LEASE_MS);
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const metrics = input.metrics ?? null;
  const metricsAt = metrics ? new Date() : null;
  const metricColumns = {
    xLikeCount: metrics?.likes ?? null,
    xRepostCount: metrics?.reposts ?? null,
    xReplyCount: metrics?.replies ?? null,
    xQuoteCount: metrics?.quotes ?? null,
    xBookmarkCount: metrics?.bookmarks ?? null,
    xImpressionCount: metrics?.impressions ?? null,
  };
  // The first snapshot stands, as a whole: a retry hours later must not mix
  // its counts into it. Only a row that has none yet takes this fetch's.
  const keepFirstSnapshot = (
    column: (typeof processedPosts)[keyof typeof metricColumns],
    value: number | null,
  ) => rawSql`CASE WHEN ${processedPosts.xMetricsAt} IS NULL THEN ${value} ELSE ${column} END`;

  const rows = await db
    .insert(processedPosts)
    .values({
      workspaceId,
      sourceId: input.sourceId ?? null,
      externalId: input.externalId,
      xPostUrl: input.xPostUrl,
      xAuthorUsername: input.xAuthorUsername,
      xCreatedAt: input.xCreatedAt,
      sourceText: input.sourceText ?? null,
      analysisText: input.analysisText ?? null,
      sourceMetadata: input.sourceMetadata ?? null,
      ...metricColumns,
      xMetricsAt: metricsAt,
      status: 'processing',
      lockedAt: new Date(),
    })
    .onConflictDoUpdate({
      // Scoped to the workspace, matching the UNIQUE index: the same post may
      // legitimately exist once per tenant.
      target: [processedPosts.workspaceId, processedPosts.externalId],
      set: {
        status: 'processing',
        sourceId: input.sourceId ?? null,
        // Filled in once, for a row first seen before the column existed;
        // otherwise what was recorded the first time stands.
        sourceText: rawSql`coalesce(${processedPosts.sourceText}, ${input.sourceText ?? null})`,
        // A retry's transcript fills one the first try could not get; one got stands.
        analysisText: rawSql`coalesce(${processedPosts.analysisText}, ${input.analysisText ?? null})`,
        sourceMetadata: input.sourceMetadata ? input.sourceMetadata : rawSql`${processedPosts.sourceMetadata}`,
        xLikeCount: keepFirstSnapshot(processedPosts.xLikeCount, metricColumns.xLikeCount),
        xRepostCount: keepFirstSnapshot(processedPosts.xRepostCount, metricColumns.xRepostCount),
        xReplyCount: keepFirstSnapshot(processedPosts.xReplyCount, metricColumns.xReplyCount),
        xQuoteCount: keepFirstSnapshot(processedPosts.xQuoteCount, metricColumns.xQuoteCount),
        xBookmarkCount: keepFirstSnapshot(processedPosts.xBookmarkCount, metricColumns.xBookmarkCount),
        xImpressionCount: keepFirstSnapshot(
          processedPosts.xImpressionCount,
          metricColumns.xImpressionCount,
        ),
        xMetricsAt: rawSql`coalesce(${processedPosts.xMetricsAt}, ${metricsAt?.toISOString() ?? null}::timestamptz)`,
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
        eq(processedPosts.externalId, input.externalId),
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
    /** The message with the buttons; both null for a post put in the review queue. */
    adminChatId: string | null;
    adminMessageId: number | null;
    /** What the reviewer is shown, kept for analysis after the decision. */
    reviewMedia?: ReviewMediaItem[];
  },
): Promise<void> {
  const queued = input.adminMessageId === null;
  await db
    .update(processedPosts)
    .set({
      status: 'awaiting_approval',
      approvalPayload: input.payload,
      ...(input.reviewMedia ? { reviewMedia: input.reviewMedia } : {}),
      originalCaption: rawSql`coalesce(${processedPosts.originalCaption}, ${input.payload.caption})`,
      caption: rawSql`coalesce(${processedPosts.caption}, ${input.payload.caption})`,
      adminChatId: input.adminChatId,
      adminMessageId: input.adminMessageId,
      reviewQueuedAt: queued ? new Date() : null,
      telegramMethod: input.payload.method,
      mediaCount: payloadMediaCount(input.payload),
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
 * Store what the reviewer wrote in the website's editor — or, with null, go
 * back to the plain post. One guarded UPDATE, only while the post has not
 * gone out: the reviewer may be pressing Approve in the chat while the editor
 * is open, and a save must not land on a post that has already left the queue.
 */
export async function setRichDocument(
  db: Database,
  input: { id: number; workspaceId: number; doc: RichDocument | null },
): Promise<{ updated: boolean; currentStatus?: PostStatus }> {
  const rows = await db
    .update(processedPosts)
    .set({
      richDoc: input.doc,
      ...(input.doc ? { captionEditedAt: new Date() } : {}),
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
  return rows.length > 0 ? { updated: true } : { updated: false, currentStatus: await findStatusInWorkspace(db, input) };
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

/**
 * Why a feed entry was passed over without review: it was already in the
 * feed when the source was added or resumed. Stats leave these rows out —
 * they are a feed's backlog, not what it brought in.
 */
export const RSS_BACKLOG_REASON = 'rss backlog present when source was followed';

/**
 * Record a feed's current entries as its backlog, settled without review, so
 * neither this run nor any later one offers them. One insert, and a row that
 * already exists — an entry seen before a pause, say — is left as it is.
 *
 * No text is kept: these were never candidates, so there is nothing for
 * Radar or a search to learn from them.
 */
export async function recordFeedBacklog(
  db: Database,
  input: {
    workspaceId: number;
    sourceId: number;
    items: { externalId: string; xPostUrl: string; xAuthorUsername: string | null; xCreatedAt: Date | null }[];
  },
): Promise<void> {
  const now = new Date();
  // A website's sitemap can hold tens of thousands: a few hundred rows a statement keeps it to few round trips.
  for (let start = 0; start < input.items.length; start += 500) {
    const chunk = input.items.slice(start, start + 500);
    await db
      .insert(processedPosts)
      .values(
        chunk.map((item) => ({
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          ...item,
          status: 'skipped' as const,
          errorMessage: RSS_BACKLOG_REASON,
          processedAt: now,
        })),
      )
      .onConflictDoNothing({ target: [processedPosts.workspaceId, processedPosts.externalId] });
  }
}

/**
 * Why a website's page never became a candidate starts with this — a page
 * that is no article, gone, not HTML, or that kept failing to load. Like a
 * feed's backlog, stats leave these rows out.
 */
export const WEBSITE_PAGE_REASON_PREFIX = 'website page: ';

interface PageRow {
  workspaceId: number;
  sourceId: number;
  externalId: string;
  xPostUrl: string;
  xAuthorUsername: string | null;
  xCreatedAt: Date | null;
}

/**
 * Settle a website's page without review — never to be fetched again — with
 * why. A page whose earlier tries failed is settled too; one already decided
 * or in review is left as it is.
 */
export async function recordSkippedPage(db: Database, input: PageRow & { reason: string }): Promise<void> {
  const { reason, ...row } = input;
  await db
    .insert(processedPosts)
    .values({ ...row, status: 'skipped', errorMessage: reason.slice(0, 2000), processedAt: new Date() })
    .onConflictDoUpdate({
      target: [processedPosts.workspaceId, processedPosts.externalId],
      set: { status: 'skipped', errorMessage: reason.slice(0, 2000), processedAt: new Date(), updatedAt: new Date() },
      where: eq(processedPosts.status, 'failed'),
    });
}

/**
 * A website's page that could not be read this time — a timeout, a server
 * error, a block. It stays new, to be tried on a later run, until it has
 * failed `maxRetryAttempts` times; then it is settled as skipped, so a page
 * that never loads does not take a place in every run for ever.
 */
export async function recordPageFailure(
  db: Database,
  input: PageRow & { error: string; maxRetryAttempts: number },
): Promise<'retry' | 'gave-up'> {
  const { error, maxRetryAttempts, ...row } = input;
  const message = `${WEBSITE_PAGE_REASON_PREFIX}could not be read: ${error}`.slice(0, 2000);
  const giveUp = maxRetryAttempts <= 1;
  const rows = await db
    .insert(processedPosts)
    .values({ ...row, status: giveUp ? 'skipped' : 'failed', errorMessage: message, retryCount: 1 })
    .onConflictDoUpdate({
      target: [processedPosts.workspaceId, processedPosts.externalId],
      set: {
        retryCount: rawSql`${processedPosts.retryCount} + 1`,
        status: rawSql`case when ${processedPosts.retryCount} + 1 >= ${maxRetryAttempts} then 'skipped'::post_status else 'failed'::post_status end`,
        errorMessage: message,
        updatedAt: new Date(),
      },
      where: eq(processedPosts.status, 'failed'),
    })
    .returning({ status: processedPosts.status });
  return rows[0]?.status === 'skipped' ? 'gave-up' : 'retry';
}

/**
 * Ids already decided or in review — everything a feed must not offer again.
 * Unlike X, a feed shows the same entries run after run, so posts waiting for
 * a reviewer or a scheduled time count too, not only terminal ones.
 */
export async function findKnownPostIds(
  db: Database,
  externalIds: string[],
  workspaceId: number,
): Promise<Set<string>> {
  const known = new Set<string>();
  // In slices: a website's sitemap can list more ids than one statement may carry.
  for (let start = 0; start < externalIds.length; start += 5000) {
    const rows = await db
      .select({ externalId: processedPosts.externalId })
      .from(processedPosts)
      .where(
        and(
          eq(processedPosts.workspaceId, workspaceId),
          inArray(processedPosts.externalId, externalIds.slice(start, start + 5000)),
          inArray(processedPosts.status, ['published', 'skipped', 'rejected', 'awaiting_approval', 'scheduled']),
        ),
      );
    for (const row of rows) known.add(row.externalId);
  }
  return known;
}

/** Record which image a post's first image is, by its bytes' fingerprint. */
export async function setPostImageFingerprint(db: Database, input: { id: number; fingerprint: string }): Promise<void> {
  await db
    .update(processedPosts)
    .set({ imageFingerprint: input.fingerprint })
    .where(eq(processedPosts.id, input.id));
}

/** Post ids we have already reached a terminal decision on. */
export async function findTerminalPostIds(
  db: Database,
  externalIds: string[],
  workspaceId: number = DEFAULT_WORKSPACE_ID,
): Promise<Set<string>> {
  if (externalIds.length === 0) return new Set();

  const rows = await db
    .select({ externalId: processedPosts.externalId })
    .from(processedPosts)
    .where(
      and(
        eq(processedPosts.workspaceId, workspaceId),
        inArray(processedPosts.externalId, externalIds),
        inArray(processedPosts.status, ['published', 'skipped', 'rejected']),
      ),
    );

  return new Set(rows.map((row) => row.externalId));
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
      externalId: processedPosts.externalId,
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
