import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  postDeliveries,
  type ApprovalPayload,
  type DeliveryMedia,
  type PostDelivery,
  type ProcessedPost,
  type ThreadsDeliveryContent,
} from '@/db/schema';
import type { Database } from '@/lib/db';
import { mediaRefsOf, richDocumentPlainText, type RichDocument } from '@/lib/rich/document';
import type { PostFooter } from '@/lib/telegram/post-footer';
import { telegramHtmlToText } from '@/lib/threads/text';
import { loadUploads, uploadRef } from '@/lib/uploads/uploads';

/**
 * A post's way to Threads, from the moment it is decided.
 *
 * What it needs is taken then — its text as it is now, and where each of its
 * pictures and videos can still be had — because the post's own payload is
 * dropped once Telegram has it. The worker (src/lib/threads/publisher.ts)
 * takes it from there.
 */

/** Threads' carousel holds 20. */
export const THREADS_MEDIA_MAX = 20;
/** A worker that died mid-step leaves its lock; after this the delivery is anyone's again. */
export const DELIVERY_LEASE_MS = 5 * 60 * 1000;
export const DELIVERY_MAX_ATTEMPTS = 4;

/**
 * The text a post goes to Threads with when it has none of its own: what
 * Telegram gets, as plain text — the rich document with the channel's
 * footer, or the caption, which carries the footer already, and its overflow.
 */
export function threadsTextFromTelegram(
  row: { richDoc: RichDocument | null; caption: string | null },
  payload: Pick<ApprovalPayload, 'caption' | 'overflowMessage'>,
  footer?: PostFooter | null,
): string {
  if (row.richDoc) {
    return [richDocumentPlainText(row.richDoc), footer?.text ?? ''].filter((part) => part.trim() !== '').join('\n\n');
  }
  return [telegramHtmlToText(row.caption ?? payload.caption), payload.overflowMessage ? telegramHtmlToText(payload.overflowMessage) : '']
    .filter((part) => part !== '')
    .join('\n\n');
}

/** What the post will be on Threads: its text and media, as decided. */
export async function threadsContentFor(
  db: Database,
  input: { row: ProcessedPost; payload: ApprovalPayload; footer?: PostFooter | null },
): Promise<ThreadsDeliveryContent> {
  const { row, payload } = input;
  // Written for Threads in the editor, or what Telegram gets.
  const text = row.threadsText ?? threadsTextFromTelegram(row, payload, input.footer);
  const own = (index: number): DeliveryMedia | null => {
    const stored = payload.items[index];
    if (stored) return { kind: stored.kind, telegramFileId: stored.fileId };
    const source = payload.sourceMedia?.[index];
    return source ? { kind: source.kind, source } : null;
  };

  if (row.richDoc) {
    const uploads = await loadUploads(db, row.id);
    const byRef = new Map(uploads.map((upload) => [uploadRef(upload), upload]));
    const media: DeliveryMedia[] = [];
    const uploadIds: number[] = [];
    for (const ref of mediaRefsOf(row.richDoc)) {
      if (ref.startsWith('u')) {
        const upload = byRef.get(ref);
        if (upload) {
          media.push({ kind: upload.kind, uploadUrl: upload.url });
          uploadIds.push(upload.id);
        }
        continue;
      }
      const item = own(Number(ref.slice(1)));
      if (item) media.push(item);
    }
    return { text, media: media.slice(0, THREADS_MEDIA_MAX), externalId: row.externalId, uploadIds };
  }

  const count = payload.items.length > 0 ? payload.items.length : (payload.sourceMedia?.length ?? 0);
  const media = Array.from({ length: count }, (_, index) => own(index)).filter((item): item is DeliveryMedia => item !== null);
  return { text, media: media.slice(0, THREADS_MEDIA_MAX), externalId: row.externalId, uploadIds: [] };
}

/** Queue the post for Threads. A post already queued keeps its delivery: deciding twice publishes once. */
export async function queueThreadsDelivery(
  db: Database,
  input: { postId: number; workspaceId: number; content: ThreadsDeliveryContent },
): Promise<void> {
  await db
    .insert(postDeliveries)
    .values({ processedPostId: input.postId, workspaceId: input.workspaceId, platform: 'threads', content: input.content })
    .onConflictDoNothing();
}

/** Deliveries a worker may take now: waiting, or processing and due a look, and not held by another run. */
export async function claimDueDeliveries(db: Database, input: { limit: number; now?: Date; ids?: number[] }): Promise<PostDelivery[]> {
  const now = input.now ?? new Date();
  const free = or(isNull(postDeliveries.lockedAt), lt(postDeliveries.lockedAt, new Date(now.getTime() - DELIVERY_LEASE_MS)));
  const due = or(isNull(postDeliveries.nextAttemptAt), lte(postDeliveries.nextAttemptAt, now));
  const candidates = await db
    .select({ id: postDeliveries.id })
    .from(postDeliveries)
    .where(
      and(
        inArray(postDeliveries.status, ['pending', 'processing']),
        free,
        due,
        input.ids ? inArray(postDeliveries.id, input.ids) : undefined,
      ),
    )
    .orderBy(asc(postDeliveries.createdAt))
    .limit(input.limit);

  const claimed: PostDelivery[] = [];
  for (const { id } of candidates) {
    // One conditional UPDATE each: a run that lost the race simply gets nothing.
    const [row] = await db
      .update(postDeliveries)
      .set({ lockedAt: now, updatedAt: now })
      .where(and(eq(postDeliveries.id, id), free, inArray(postDeliveries.status, ['pending', 'processing'])))
      .returning();
    if (row) claimed.push(row);
  }
  return claimed;
}

export async function updateDelivery(
  db: Database,
  id: number,
  values: Partial<Pick<PostDelivery, 'status' | 'containerId' | 'hostedUrls' | 'attempts' | 'nextAttemptAt' | 'externalId' | 'url' | 'error' | 'publishedAt' | 'lockedAt'>>,
): Promise<void> {
  await db
    .update(postDeliveries)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(postDeliveries.id, id));
}

/** The Threads deliveries of these posts, for showing how they went. */
export function deliveriesOf(db: Database, postIds: number[]): Promise<PostDelivery[]> {
  if (postIds.length === 0) return Promise.resolve([]);
  return db.select().from(postDeliveries).where(inArray(postDeliveries.processedPostId, postIds));
}

/** How many are waiting, for a run's summary. */
export async function countOpenDeliveries(db: Database): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(postDeliveries)
    .where(inArray(postDeliveries.status, ['pending', 'processing']));
  return row?.count ?? 0;
}
