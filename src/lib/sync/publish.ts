import { payloadMediaCount, type ApprovalPayload, type ProcessedPost } from '@/db/schema';
import type { Database } from '@/lib/db';
import type { Env } from '@/lib/env';
import { createLogger, type Logger } from '@/lib/logger';
import { acquireMedia } from '@/lib/sync/acquire-media';
import type { TelegramClient } from '@/lib/telegram/client';
import type { TelegramDestination } from '@/lib/workspace';
import { publishApprovedPayload, type PublishResult } from '@/lib/sync/approval';
import { markPublished } from '@/lib/sync/repository';
import { mediaRefsOf, richDocumentToHtml, type RichDocument } from '@/lib/rich/document';
import type { PostFooter } from '@/lib/telegram/post-footer';
import { sendRichMessage, type MediaPayload } from '@/lib/telegram/send-media';
import { refreshChannelMedia } from '@/lib/telegram-channel/refresh-media';
import {
  deleteUploads,
  loadUploads,
  uploadAsMedia,
  uploadRef,
  vercelBlobStore,
  type BlobStore,
} from '@/lib/uploads/uploads';

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
 * A Telegram channel's post has its media's links looked up afresh first
 * (src/lib/telegram-channel/refresh-media.ts).
 *
 * A post written in the website's editor goes out as one rich message —
 * its own text and layout, with the channel's footer — instead.
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
  /** The channel's footer, which closes a rich post; a plain post has it in its caption already. */
  footer?: PostFooter | null;
  /** When a person approved it now; omitted when the decision was made earlier. */
  reviewedAt?: Date;
  /** Where the editor's uploads are, to delete once published; the env's Blob store when omitted. */
  blobStore?: BlobStore | null;
}): Promise<PublishResult> {
  if (input.row.richDoc) return publishRichPost({ ...input, doc: input.row.richDoc });

  // The caption column, not the payload's copy, is what gets published: it is
  // the one an edit is guaranteed to have written. The fallback covers a post
  // queued before the column existed.
  const payload = { ...input.payload, caption: input.row.caption ?? input.payload.caption };

  const media =
    payload.items.length === 0 && payload.sourceMedia?.length
      ? await acquireMedia(await refreshChannelMedia(input.row.externalId, payload.sourceMedia, { fetchImpl: input.fetchImpl }), {
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

/**
 * A rich post: only the media its document places are sent — from
 * Telegram's own copies for a post reviewed in the chat, fetched again from X
 * for a queued one, and the editor's uploads from the Blob store — all of
 * them before the message is sent. Once it is out, the post's uploads are
 * deleted from the store.
 */
async function publishRichPost(
  input: Parameters<typeof publishDecidedPost>[0] & { doc: RichDocument },
): Promise<PublishResult> {
  const { payload } = input;
  const logger = input.logger ?? createLogger({ app: 'content-arbitrary' });
  const kinds = payload.items.length > 0 ? payload.items.map((item) => item.kind) : (payload.sourceMedia ?? []).map((media) => media.kind);
  const refs = mediaRefsOf(input.doc);
  const own = refs.filter((ref) => ref.startsWith('m'));
  const uploads = refs.length > own.length ? await loadUploads(input.db, input.row.id) : [];
  const uploadsByRef = new Map(uploads.map((upload) => [uploadRef(upload), upload]));

  // Looked up afresh only when some of them are fetched again, not re-sent from Telegram's copies.
  const sourceMedia =
    payload.sourceMedia && own.some((ref) => !payload.items[Number(ref.slice(1))])
      ? await refreshChannelMedia(input.row.externalId, payload.sourceMedia, { fetchImpl: input.fetchImpl })
      : payload.sourceMedia;

  const media: { ref: string; payload: MediaPayload }[] = [];
  for (const ref of refs) {
    if (ref.startsWith('u')) {
      const upload = uploadsByRef.get(ref);
      if (!upload) throw new Error(`rich post places upload ${ref}, which is not in the store`);
      const [acquired] = await acquireMedia([uploadAsMedia(upload)], { env: input.env, logger, fetchImpl: input.fetchImpl });
      media.push({ ref, payload: acquired! });
      continue;
    }
    const index = Number(ref.slice(1));
    const stored = payload.items[index];
    if (stored) {
      media.push({
        ref,
        payload: {
          mode: 'file_id',
          fileId: stored.fileId,
          media: { mediaKey: stored.fileId, kind: stored.kind, url: stored.fileId, width: stored.width, height: stored.height },
        },
      });
      continue;
    }
    const source = sourceMedia?.[index];
    if (!source) throw new Error(`rich post places media ${ref}, which the post does not have`);
    const [acquired] = await acquireMedia([source], { env: input.env, logger, fetchImpl: input.fetchImpl });
    media.push({ ref, payload: acquired! });
  }

  const message = await sendRichMessage(
    { client: input.client, chatId: input.destination.chatId, disableNotification: input.destination.disableNotification },
    richDocumentToHtml(input.doc, {
      mediaKinds: { own: kinds, uploads: new Map(uploads.map((upload) => [uploadRef(upload), upload.kind])) },
      footerHtml: input.footer?.html,
    }),
    media,
  );
  const result: PublishResult = {
    messages: [{ messageId: message.message_id, mediaIndex: null, kind: 'rich' }],
    primaryMessageId: message.message_id,
    method: 'sendRichMessage',
  };

  await markPublished(input.db, {
    id: input.row.id,
    telegramChatId: input.destination.chatId,
    primaryMessageId: result.primaryMessageId,
    telegramMethod: result.method,
    mediaCount: refs.length,
    messages: result.messages,
    reviewedAt: input.reviewedAt,
  });

  // Out in the channel: the store need not hold its files, placed or not. Best effort — the sweep after each sync catches the rest.
  const store =
    input.blobStore !== undefined
      ? input.blobStore
      : input.env.BLOB_READ_WRITE_TOKEN
        ? vercelBlobStore(input.env.BLOB_READ_WRITE_TOKEN)
        : null;
  if (store) await deleteUploads(input.db, store, await loadUploads(input.db, input.row.id), logger).catch(() => 0);
  return result;
}
