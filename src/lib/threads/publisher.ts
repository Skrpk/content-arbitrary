import { randomBytes } from 'node:crypto';
import { del, put } from '@vercel/blob';
import { eq } from 'drizzle-orm';
import { processedPosts, type DeliveryMedia, type PostDelivery } from '@/db/schema';
import type { Database } from '@/lib/db';
import type { Env } from '@/lib/env';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { acquireMedia } from '@/lib/sync/acquire-media';
import type { TelegramClient } from '@/lib/telegram/client';
import { escapeHtml } from '@/lib/telegram/format-caption';
import { sendText } from '@/lib/telegram/send-media';
import { refreshChannelMedia } from '@/lib/telegram-channel/refresh-media';
import { threadsAccessToken, threadsAccountsFor } from '@/lib/threads/accounts';
import {
  containerStatus,
  createContainer,
  permalinkOf,
  publishContainer,
  type ThreadsCallOptions,
} from '@/lib/threads/client';
import { threadsApp } from '@/lib/threads/config';
import { claimDueDeliveries, DELIVERY_MAX_ATTEMPTS, updateDelivery } from '@/lib/threads/deliveries';
import { threadsTextFor } from '@/lib/threads/text';
import { deleteUploads, loadUploads, uploadsAvailable, vercelBlobStore } from '@/lib/uploads/uploads';
import { findWorkspaceById } from '@/lib/workspace';

/**
 * Publishing decided posts to Threads, a step at a time.
 *
 * Threads publishes in two steps: a container is made — Threads fetches the
 * media from public addresses and processes them — and published once it is
 * ready, which for a video takes a while. So each run takes a delivery as far
 * as it can: its media copied where Threads can fetch them (the Blob store,
 * deleted afterwards), the container made, and — if Threads is done within a
 * short wait — published. Otherwise the next run looks again.
 *
 * A step that fails is tried again later, a few times, then given up on, and
 * the channel's reviewer is told. Telegram is never touched again: whatever
 * happens here, the post's Telegram side is settled already.
 */

/** Where media are put for Threads to fetch, and taken away from. */
export interface MediaHost {
  put(path: string, bytes: Uint8Array, contentType: string): Promise<string>;
  del(urls: string[]): Promise<void>;
}

export function blobMediaHost(env: Pick<Env, 'BLOB_STORE_ID' | 'BLOB_READ_WRITE_TOKEN'>): MediaHost | null {
  if (!uploadsAvailable(env)) return null;
  const token = env.BLOB_READ_WRITE_TOKEN ? { token: env.BLOB_READ_WRITE_TOKEN } : {};
  return {
    put: async (path, bytes, contentType) =>
      (await put(path, Buffer.from(bytes), { access: 'public', contentType, addRandomSuffix: false, ...token })).url,
    del: (urls) => del(urls, token),
  };
}

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
/** How long a run waits on a container before leaving it to the next. */
const POLL_BUDGET_MS = 20_000;
const POLL_INTERVAL_MS = 3_000;
/** Between a processing container's looks, across runs. */
const RECHECK_MS = 30_000;
const THREADS_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);

export interface ThreadsRunSummary {
  published: number;
  waiting: number;
  retrying: number;
  failed: number;
}

export async function runThreadsDeliveries(input: {
  db: Database;
  env: Env;
  client: TelegramClient;
  logger: Logger;
  /** Only these deliveries, as right after a decision; every due one otherwise. */
  ids?: number[];
  limit?: number;
  host?: MediaHost | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** How long to wait on a container before leaving it to the next run. */
  pollBudgetMs?: number;
} & ThreadsCallOptions): Promise<ThreadsRunSummary> {
  const summary: ThreadsRunSummary = { published: 0, waiting: 0, retrying: 0, failed: 0 };
  const app = threadsApp(input.env);
  if (!app) return summary;

  const deliveries = await claimDueDeliveries(input.db, { limit: input.limit ?? 5, ids: input.ids, now: input.now?.() });
  for (const delivery of deliveries) {
    const outcome = await step(delivery, { ...input, app });
    summary[outcome] += 1;
  }
  return summary;
}

type Outcome = keyof ThreadsRunSummary;

async function step(
  delivery: PostDelivery,
  input: Parameters<typeof runThreadsDeliveries>[0] & { app: NonNullable<ReturnType<typeof threadsApp>> },
): Promise<Outcome> {
  const { db, logger } = input;
  const now = input.now ?? (() => new Date());
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = logger.child({ deliveryId: delivery.id, postId: delivery.processedPostId, workspaceId: delivery.workspaceId });

  const [account] = await threadsAccountsFor(db, [delivery.workspaceId]);
  if (!account) return giveUp(delivery, 'Threads is not connected for this channel any more.', input, log);

  try {
    const token = threadsAccessToken(account, input.app);
    const who = { threadsUserId: account.threadsUserId, token };

    let containerId = delivery.containerId;
    let hostedUrls = delivery.hostedUrls;
    if (!containerId) {
      const media = await mediaUrls(delivery, input, log);
      hostedUrls = media.hosted;
      containerId = await makeContainer(who, delivery.content.text, media.items, input);
      await updateDelivery(db, delivery.id, { status: 'processing', containerId, hostedUrls });
      log.info('threads.container_created', { media: media.items.length });
    }

    // A short wait here saves a text post — ready at once — a minute in the queue.
    const deadline = Date.now() + (input.pollBudgetMs ?? POLL_BUDGET_MS);
    for (;;) {
      const state = await containerStatus(token, containerId, input);
      if (state.status === 'FINISHED') break;
      if (state.status === 'ERROR' || state.status === 'EXPIRED') {
        // Started again from the media on the next try: a failed container cannot be published.
        const host = input.host !== undefined ? input.host : blobMediaHost(input.env);
        if (host && hostedUrls.length > 0) await host.del(hostedUrls).catch(() => {});
        await updateDelivery(db, delivery.id, { containerId: null, hostedUrls: [] });
        throw new Error(`Threads could not process the post: ${state.error ?? state.status.toLowerCase()}`);
      }
      if (state.status === 'PUBLISHED') {
        // Published by a run that died before it could say so: done, its id unknown.
        log.warn('threads.container_already_published', {});
        await updateDelivery(db, delivery.id, { status: 'published', error: null, publishedAt: now(), lockedAt: null, hostedUrls: [] });
        await cleanUp(delivery, hostedUrls, input, log);
        return 'published';
      }
      if (Date.now() >= deadline) {
        await updateDelivery(db, delivery.id, { lockedAt: null, nextAttemptAt: new Date(now().getTime() + RECHECK_MS) });
        return 'waiting';
      }
      await sleep(POLL_INTERVAL_MS);
    }

    const mediaId = await publishContainer(who, containerId, input);
    const url = await permalinkOf(token, mediaId, input).catch(() => null);
    await updateDelivery(db, delivery.id, {
      status: 'published',
      externalId: mediaId,
      url,
      error: null,
      publishedAt: now(),
      lockedAt: null,
      hostedUrls: [],
    });
    log.info('threads.published', { mediaId });
    await cleanUp(delivery, hostedUrls, input, log);
    return 'published';
  } catch (error) {
    const message = describeError(error).slice(0, 500);
    const attempts = delivery.attempts + 1;
    if (attempts >= DELIVERY_MAX_ATTEMPTS) return giveUp({ ...delivery, attempts }, message, input, log);
    await updateDelivery(db, delivery.id, {
      attempts,
      error: message,
      lockedAt: null,
      nextAttemptAt: new Date(now().getTime() + RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]!),
    });
    log.warn('threads.step_failed', { attempts, error: message });
    return 'retrying';
  }
}

/** Every picture and video at an address Threads can fetch, copying to the Blob store what has none. */
async function mediaUrls(
  delivery: PostDelivery,
  input: Parameters<typeof step>[1],
  log: Logger,
): Promise<{ items: { kind: 'photo' | 'video'; url: string }[]; hosted: string[] }> {
  const items: { kind: 'photo' | 'video'; url: string }[] = [];
  const hosted: string[] = [];
  const media = delivery.content.media;
  if (media.length === 0) return { items, hosted };

  // A Telegram channel's links expire: looked up afresh, all at once.
  const sources = media.flatMap((item) => ('source' in item ? [item.source] : []));
  const fresh = sources.length > 0 ? await refreshChannelMedia(delivery.content.externalId, sources, input) : [];
  let nextSource = 0;

  const host = input.host !== undefined ? input.host : blobMediaHost(input.env);
  const hostBytes = async (index: number, bytes: Uint8Array, contentType: string) => {
    if (!host) throw new Error('Publishing media to Threads needs the Blob store, and none is connected.');
    const extension = contentType.includes('png') ? 'png' : contentType.startsWith('video/') ? 'mp4' : 'jpg';
    const url = await host.put(`threads/${delivery.id}/${index}-${randomBytes(8).toString('hex')}.${extension}`, bytes, contentType);
    hosted.push(url);
    return url;
  };

  try {
    for (const [index, item] of media.entries()) {
      items.push({ kind: item.kind, url: await urlFor(index, item) });
    }
  } catch (error) {
    if (host && hosted.length > 0) await host.del(hosted).catch(() => {});
    throw error;
  }
  log.info('threads.media_ready', { count: items.length, hosted: hosted.length });
  return { items, hosted };

  async function urlFor(index: number, item: DeliveryMedia): Promise<string> {
    if ('uploadUrl' in item) return item.uploadUrl;
    if ('telegramFileId' in item) {
      const file = await input.client.downloadFile(item.telegramFileId);
      const contentType = contentTypeOf(file.filePath, item.kind);
      checkType(contentType, item.kind);
      return hostBytes(index, file.bytes, contentType);
    }
    const source = fresh[nextSource++] ?? item.source;
    const [acquired] = await acquireMedia([source], { env: input.env, logger: log, fetchImpl: input.fetchImpl });
    if (!acquired) throw new Error('a picture of the post could not be fetched');
    // Fetched only to be measured: a public address Threads can fetch itself.
    if (acquired.mode !== 'multipart') return acquired.media.url;
    const contentType = acquired.downloaded.contentType.split(';')[0]!.trim().toLowerCase();
    checkType(contentType, item.kind);
    return hostBytes(index, acquired.downloaded.bytes, contentType);
  }
}

function contentTypeOf(path: string, kind: 'photo' | 'video'): string {
  const extension = path.split('.').pop()?.toLowerCase();
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'mp4' || extension === 'mov') return 'video/mp4';
  return kind === 'video' ? 'video/mp4' : 'image/jpeg';
}

function checkType(contentType: string, kind: 'photo' | 'video'): void {
  if (kind === 'photo' && !THREADS_IMAGE_TYPES.has(contentType)) {
    throw new Error(`Threads takes JPEG and PNG pictures only; this one is ${contentType}.`);
  }
}

/** The post's container: text alone, one picture or video, or a carousel of them. */
async function makeContainer(
  who: { threadsUserId: string; token: string },
  fullText: string,
  media: { kind: 'photo' | 'video'; url: string }[],
  options: ThreadsCallOptions,
): Promise<string> {
  const { text, attachment } = threadsTextFor(fullText, media.length > 0);
  if (media.length === 0) {
    if (!text) throw new Error('The post has neither text nor media to publish.');
    return createContainer(who, { mediaType: 'TEXT', text, attachment }, options);
  }
  const spec = (item: (typeof media)[number], carouselItem: boolean) =>
    item.kind === 'video'
      ? ({ mediaType: 'VIDEO', videoUrl: item.url, carouselItem, ...(carouselItem ? {} : { text }) } as const)
      : ({ mediaType: 'IMAGE', imageUrl: item.url, carouselItem, ...(carouselItem ? {} : { text }) } as const);
  if (media.length === 1) return createContainer(who, spec(media[0]!, false), options);
  const children: string[] = [];
  for (const item of media) children.push(await createContainer(who, spec(item, true), options));
  return createContainer(who, { mediaType: 'CAROUSEL', children, text }, options);
}

/** Done with: the copies made for Threads, and the editor's uploads once Telegram and Threads both have them. */
async function cleanUp(delivery: PostDelivery, hostedUrls: string[], input: Parameters<typeof step>[1], log: Logger): Promise<void> {
  const host = input.host !== undefined ? input.host : blobMediaHost(input.env);
  if (host && hostedUrls.length > 0) await host.del(hostedUrls).catch((error: unknown) => log.warn('threads.cleanup_failed', { error: describeError(error) }));
  if (delivery.content.uploadIds.length > 0 && uploadsAvailable(input.env)) {
    const uploads = (await loadUploads(input.db, delivery.processedPostId)).filter((upload) => delivery.content.uploadIds.includes(upload.id));
    await deleteUploads(input.db, vercelBlobStore(input.env.BLOB_READ_WRITE_TOKEN), uploads, log).catch(() => 0);
  }
}

/** Given up on: marked failed, cleaned up, and the channel's reviewer told. */
async function giveUp(delivery: PostDelivery, reason: string, input: Parameters<typeof step>[1], log: Logger): Promise<Outcome> {
  await updateDelivery(input.db, delivery.id, {
    status: 'failed',
    attempts: delivery.attempts,
    error: reason,
    lockedAt: null,
    containerId: null,
    hostedUrls: [],
  });
  log.error('threads.delivery_failed', { attempts: delivery.attempts, error: reason });
  await cleanUp(delivery, delivery.hostedUrls, input, log);

  const workspace = await findWorkspaceById(input.db, delivery.workspaceId);
  const [post] = await input.db
    .select({ url: processedPosts.xPostUrl })
    .from(processedPosts)
    .where(eq(processedPosts.id, delivery.processedPostId));
  if (workspace?.telegramAdminChatId) {
    await sendText(
      { client: input.client, chatId: workspace.telegramAdminChatId, disableNotification: false },
      [`⚠️ Not published to Threads: ${escapeHtml(reason.slice(0, 300))}`, post?.url ? escapeHtml(post.url) : '']
        .filter(Boolean)
        .join('\n'),
    ).catch((error: unknown) => log.warn('threads.notify_failed', { error: describeError(error) }));
  }
  return 'failed';
}
