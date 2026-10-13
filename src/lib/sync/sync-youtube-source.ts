import type { Source } from '@/db/schema';
import { describeError, YouTubeApiError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { syncStateKey } from '@/lib/sources/repository';
import { processCandidate, type CandidateContext } from '@/lib/sync/process-candidate';
import { findKnownPostIds, upsertSyncState } from '@/lib/sync/repository';
import { YOUTUBE_VIDEO_ID_PREFIX } from '@/lib/sources/display';
import { uploadsPlaylistOf } from '@/lib/youtube/channel';
import type { YouTubeClient, YouTubeUpload } from '@/lib/youtube/client';
import { videoToPost } from '@/lib/youtube/normalize';
import { logTranscript, type VideoTranscriptProvider } from '@/lib/youtube/transcript';
import type { SourceSyncSummary } from '@/types';

/**
 * One synchronisation pass over a YouTube channel.
 *
 * Its uploads playlist lists the newest videos first. A video's id says
 * nothing of its order, so, as for a feed, a video is new by identity: one
 * published since the source was followed (no backfill of what the channel
 * had before) and not already in review or settled in `processed_posts`. The pass reads
 * back until it meets a video from before that, or one it has settled; takes
 * the new ones' details in one batched videos.list; and hands them on oldest
 * first. A premiere still to come is left for when it is out.
 *
 * Each video's transcript is asked for on the way — enrichment: when there is
 * none, or the provider fails, the video goes on with its metadata alone.
 * Like the other passes this never throws; a channel that fails says why in
 * its summary, and is read again next run from where it was.
 */

/** Videos read a page — a channel posting more than this between runs is read on, page by page. */
export const UPLOADS_PAGE_SIZE = 15;
const UPLOADS_MAX_PAGES = 3;

export interface YouTubeSyncContext extends CandidateContext {
  logger: Logger;
  /** Null without YOUTUBE_API_KEY: the channel cannot be read, and says so. */
  youtube: YouTubeClient | null;
  /** Null without SUPADATA_API_KEY: videos go on with their metadata alone. */
  transcripts: VideoTranscriptProvider | null;
  /** When to stop taking new posts (epoch ms); unset, there is no limit. */
  deadline?: number;
  now?: () => number;
}

export async function syncYouTubeSource(source: Source, context: YouTubeSyncContext): Promise<SourceSyncSummary> {
  const { db, env } = context;
  const stateKey = syncStateKey(source);
  const logger = context.logger.child({
    platform: 'youtube',
    sourceId: source.id,
    workspaceId: source.workspaceId,
    channelId: source.externalId,
  });
  const startedAt = Date.now();

  const summary: SourceSyncSummary = {
    sourceId: source.id,
    workspaceId: source.workspaceId,
    platform: source.platform,
    externalId: source.externalId,
    username: source.username,
    checked: 0,
    newPosts: 0,
    published: 0,
    awaitingApproval: 0,
    failed: 0,
    skipped: 0,
  };

  try {
    if (!context.youtube) throw new YouTubeApiError('YOUTUBE_API_KEY is not set', { transient: false, code: 'youtube_not_configured' });
    const youtube = context.youtube;
    await upsertSyncState(db, { source: stateKey, workspaceId: source.workspaceId, lastSyncAt: new Date() });
    logger.info('youtube.sync_started', { followingSince: source.followingSince });

    // As for a feed: what waits for a reviewer or a time counts as known too, or its
    // transcript would be asked for again every run.
    const window = await readNewUploads(youtube, source, async (ids) =>
      findKnownPostIds(
        db,
        ids.map((id) => `${YOUTUBE_VIDEO_ID_PREFIX}${id}`),
        source.workspaceId,
      ),
    );
    summary.checked = window.read;
    if (window.overflow) summary.windowOverflow = true;
    logger.info('youtube.videos_fetched', { read: window.read, pages: window.pages, fresh: window.fresh.length });

    // Oldest first, as many as a run takes; the rest are still new next time.
    const batch = window.fresh.slice(0, env.MAX_POSTS_PER_RUN);
    if (window.fresh.length > batch.length) {
      logger.info('sync.batch_limited', { available: window.fresh.length, processing: batch.length, maxPostsPerRun: env.MAX_POSTS_PER_RUN });
    }
    const videos = new Map((await youtube.getVideos(batch.map((upload) => upload.videoId))).map((video) => [video.id, video]));
    const now = context.now ?? Date.now;

    for (const [index, upload] of batch.entries()) {
      if (context.deadline !== undefined && now() >= context.deadline) {
        summary.stoppedForTime = true;
        logger.warn('sync.time_budget_reached', { unprocessed: batch.length - index });
        break;
      }
      const video = videos.get(upload.videoId);
      if (!video) {
        logger.info('sync.post_skipped', { videoId: upload.videoId, reason: 'no longer available' });
        summary.skipped += 1;
        continue;
      }
      if (video.liveBroadcastContent === 'upcoming') {
        logger.info('sync.post_skipped', { videoId: video.id, reason: 'a premiere still to come' });
        summary.skipped += 1;
        continue;
      }
      logger.info('youtube.video_discovered', {
        videoId: video.id,
        publishedAt: video.publishedAt,
        duration: video.durationSeconds,
        live: video.liveBroadcastContent,
      });

      let transcript = null;
      if (context.transcripts) {
        const asked = Date.now();
        transcript = await context.transcripts.getTranscript(`https://www.youtube.com/watch?v=${video.id}`);
        logTranscript(logger, transcript, { videoId: video.id, provider: context.transcripts.name, latencyMs: Date.now() - asked });
      }

      summary.newPosts += 1;
      const post = videoToPost(video, transcript, context.transcripts?.name ?? null);
      await processCandidate(post, source, context, summary, {
        logger: logger.child({ externalId: post.id }),
        // A video has no media of its own: it goes out as its text and its link.
        textOnly: true,
        spaceOut: index > 0,
      });
    }

    await upsertSyncState(db, {
      source: stateKey,
      workspaceId: source.workspaceId,
      ...(window.newestId && !env.DRY_RUN ? { lastSeenPostId: window.newestId } : {}),
      lastSuccessfulSyncAt: new Date(),
      lastError: null,
    });
    logger.info('youtube.sync_completed', { ...summary, latencyMs: Date.now() - startedAt });
    return summary;
  } catch (error) {
    const message = describeError(error);
    summary.error = message;
    logger.error('youtube.sync_failed', { error: message, latencyMs: Date.now() - startedAt });
    await upsertSyncState(db, { source: stateKey, workspaceId: source.workspaceId, lastError: message }).catch(() => {});
    return summary;
  }
}

/**
 * The channel's new uploads, oldest first: newest page first, read back until
 * a video from before the source was followed, or one already settled, or
 * the page limit. The uploads playlist is the channel's own (`UU…`); a
 * channel that names it otherwise is asked once.
 */
async function readNewUploads(
  youtube: YouTubeClient,
  source: Source,
  settled: (videoIds: string[]) => Promise<Set<string>>,
): Promise<{ fresh: YouTubeUpload[]; read: number; pages: number; overflow: boolean; newestId: string | null }> {
  let playlistId = uploadsPlaylistOf(source.externalId);
  const fresh: YouTubeUpload[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  let read = 0;
  let newestId: string | null = null;

  for (;;) {
    let page;
    try {
      page = await youtube.listUploads(playlistId, { maxResults: UPLOADS_PAGE_SIZE, pageToken });
    } catch (error) {
      if (pages === 0 && error instanceof YouTubeApiError && error.status === 404) {
        const channel = await youtube.getChannel({ kind: 'id', id: source.externalId });
        if (!channel?.uploadsPlaylistId || channel.uploadsPlaylistId === playlistId) throw error;
        playlistId = channel.uploadsPlaylistId;
        continue;
      }
      throw error;
    }
    pages += 1;
    read += page.uploads.length;
    newestId ??= page.uploads[0]?.videoId ?? null;

    const done = await settled(page.uploads.map((upload) => upload.videoId));
    let reachedKnown = false;
    for (const upload of page.uploads) {
      // Not out yet: a premiere, taken when it is.
      if (!upload.publishedAt) continue;
      if (upload.publishedAt < source.followingSince || done.has(`${YOUTUBE_VIDEO_ID_PREFIX}${upload.videoId}`)) {
        reachedKnown = true;
        continue;
      }
      fresh.push(upload);
    }
    if (reachedKnown || !page.nextPageToken) return { fresh: fresh.reverse(), read, pages, overflow: false, newestId };
    if (pages >= UPLOADS_MAX_PAGES) return { fresh: fresh.reverse(), read, pages, overflow: true, newestId };
    pageToken = page.nextPageToken;
  }
}
