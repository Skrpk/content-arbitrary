import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import { publicationHistoryItems, type HistoricalMediaItem } from '@/db/schema';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { imageFingerprint } from '@/lib/media/image';
import type { ImageUnderstander } from '@/lib/media/provider';
import { findUnderstanding } from '@/lib/media/repository';
import { understandImage } from '@/lib/media/understand';
import type { MediaUnderstandingConfig } from '@/lib/media/understanding';

/**
 * Understand the images of a workspace's imported publication history, from
 * the export's files on disk — the first photo of each item, once.
 *
 * Resumable by construction: an item whose image already has an
 * understanding for the current model and prompt is passed over, so a run
 * that stopped halfway, or one with --limit, is simply run again. Items whose
 * photo the export left out, or whose file is not under the media root, are
 * counted and skipped, never fetched from anywhere else.
 */

export interface HistoryImageSummary {
  /** History items whose media include a photo. */
  imageItems: number;
  unavailable: number;
  alreadyUnderstood: number;
  /** Would be (dry run) or were sent to the model. */
  toUnderstand: number;
  understood: number;
  failed: number;
  /** Left for a later run by --limit. */
  overLimit: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export async function understandHistoryImages(input: {
  db: Database;
  understander: ImageUnderstander | null;
  config: MediaUnderstandingConfig;
  workspaceId: number;
  /** The export's directory: what each item's `relativePath` is relative to. */
  mediaRoot: string;
  /** Send at most this many images to the model this run. */
  limit?: number;
  /** Count what would be sent, without calling the model or writing. */
  dryRun?: boolean;
  /** Images sent at once. */
  concurrency?: number;
  logger?: Logger;
}): Promise<HistoryImageSummary> {
  const root = resolve(input.mediaRoot);
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`--media-root ${input.mediaRoot} is not a directory: point it at the Telegram export's folder`);
  }
  if (!input.dryRun && !input.understander) throw new Error('OPENAI_API_KEY is not set; images are understood by OpenAI');

  const items = await input.db
    .select({
      id: publicationHistoryItems.id,
      title: publicationHistoryItems.title,
      text: publicationHistoryItems.text,
      media: publicationHistoryItems.media,
      imageFingerprint: publicationHistoryItems.imageFingerprint,
    })
    .from(publicationHistoryItems)
    .where(eq(publicationHistoryItems.workspaceId, input.workspaceId))
    .orderBy(asc(publicationHistoryItems.publishedAt), asc(publicationHistoryItems.id));

  const summary: HistoryImageSummary = {
    imageItems: 0,
    unavailable: 0,
    alreadyUnderstood: 0,
    toUnderstand: 0,
    understood: 0,
    failed: 0,
    overLimit: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };

  const queue: { id: number; caption: string; bytes: Uint8Array }[] = [];

  for (const item of items) {
    const photo = firstPhoto(item.media);
    if (!photo) continue;
    summary.imageItems += 1;

    const file = photo.available && photo.relativePath ? insideRoot(root, photo.relativePath) : null;
    const bytes = file ? await readFile(file).catch(() => null) : null;
    if (!bytes) {
      summary.unavailable += 1;
      continue;
    }

    const fingerprint = imageFingerprint(bytes);
    if (!input.dryRun && item.imageFingerprint !== fingerprint) {
      await setItemFingerprint(input.db, input.workspaceId, item.id, fingerprint);
    }

    const existing = await findUnderstanding(input.db, { fingerprint, config: input.config });
    if (existing?.status === 'ok') {
      summary.alreadyUnderstood += 1;
      continue;
    }

    if (input.limit !== undefined && summary.toUnderstand >= input.limit) {
      summary.overLimit += 1;
      continue;
    }
    summary.toUnderstand += 1;
    queue.push({ id: item.id, caption: [item.title, item.text].filter(Boolean).join('\n\n'), bytes });
  }

  if (input.dryRun || queue.length === 0) return summary;

  const understander = input.understander!;
  const workers = Array.from({ length: Math.max(1, input.concurrency ?? 4) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const result = await understandImage({
        db: input.db,
        understander,
        config: input.config,
        bytes: next.bytes,
        caption: next.caption,
        logger: input.logger?.child({ historyItemId: next.id }),
      });
      if (result.understanding) summary.understood += 1;
      else summary.failed += 1;
      if (!result.cached && result.row) {
        summary.inputTokens += result.row.inputTokens ?? 0;
        summary.outputTokens += result.row.outputTokens ?? 0;
        summary.costUsd += result.row.costUsd ?? 0;
      }
    }
  });
  await Promise.all(workers);

  input.logger?.info('history.images_understood', {
    workspaceId: input.workspaceId,
    understood: summary.understood,
    failed: summary.failed,
    unavailable: summary.unavailable,
    usage: { input: summary.inputTokens, output: summary.outputTokens },
  });
  return summary;
}

/** The item's first photo — only one image per item is understood. */
function firstPhoto(media: HistoricalMediaItem[]): HistoricalMediaItem | null {
  return media.find((item) => item.type === 'photo') ?? null;
}

/** The file's path, if it lies inside the root; null for one that would climb out of it. */
function insideRoot(root: string, relativePath: string): string | null {
  const path = resolve(root, relativePath);
  const fromRoot = relative(root, path);
  return fromRoot && !fromRoot.startsWith('..') && !isAbsolute(fromRoot) ? path : null;
}

async function setItemFingerprint(db: Database, workspaceId: number, id: number, fingerprint: string) {
  try {
    await db
      .update(publicationHistoryItems)
      .set({ imageFingerprint: fingerprint })
      .where(and(eq(publicationHistoryItems.id, id), eq(publicationHistoryItems.workspaceId, workspaceId)));
  } catch (error) {
    throw new Error(`could not record the image of history item ${id}: ${describeError(error)}`);
  }
}
