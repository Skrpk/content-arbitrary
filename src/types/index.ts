/** One progressive MP4 rendition of a video, as published by X. */
export interface Mp4Variant {
  url: string;
  bitRate?: number;
  contentType: string;
}

/** Media item ready to be handed to Telegram. */
export interface NormalizedMedia {
  /** X `media_key`, used to de-duplicate assets within a post. */
  mediaKey: string;
  kind: 'photo' | 'video';
  /** Direct CDN URL. For video this is the best MP4 variant. */
  url: string;
  width?: number;
  height?: number;
  /** Video only. Telegram wants seconds; X reports milliseconds. */
  durationSeconds?: number;
  /** Video only, from the chosen variant. */
  bitRate?: number;
  contentType?: string;
  /** Video only. X's still image of the video, for anything that needs a picture of it. */
  previewUrl?: string;
  /** animated_gif is delivered by X as a silent MP4; we send it as a video. */
  wasAnimatedGif?: boolean;
  /**
   * Video only. Every progressive MP4 rendition X offers, highest bitrate
   * first, so a smaller one can be substituted when the best exceeds the
   * Telegram upload limit.
   */
  mp4Variants?: Mp4Variant[];
}

/** An X post reduced to only what the publisher needs. */
export interface NormalizedPost {
  id: string;
  url: string;
  authorUsername: string;
  createdAt: Date | null;
  /**
   * The author's whole text — the full text of a long-form post, not X's
   * 280-character cut — with t.co noise already resolved/removed.
   */
  text: string;
  media: NormalizedMedia[];
  isReply: boolean;
  isRepost: boolean;
  isQuote: boolean;
  /** Engagement as X reported it in this fetch; null when X sent none. */
  metrics?: PostMetrics | null;
}

/** A post's public engagement counts at one moment. A count X omitted is null. */
export interface PostMetrics {
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  quotes: number | null;
  bookmarks: number | null;
  impressions: number | null;
}

/** Outcome of one source's pass, so a failure can be attributed. */
export interface SourceSyncSummary {
  sourceId: number;
  workspaceId: number;
  platform: string;
  externalId: string;
  username: string;
  checked: number;
  newPosts: number;
  published: number;
  awaitingApproval: number;
  failed: number;
  skipped: number;
  error?: string;
}

export interface SyncSummary {
  checked: number;
  newPosts: number;
  published: number;
  /** Sent to the reviewer, not yet in the channel. */
  awaitingApproval: number;
  failed: number;
  skipped: number;
  /** Per-source breakdown of the totals above, across every tenant. */
  sources: SourceSyncSummary[];
  /** How many tenants this run actually visited. */
  workspaces: number;
  /** Tenants passed over, with the reason — mid-setup, or busy elsewhere. */
  skippedWorkspaces?: { workspaceId: number; reason: string }[];
  dryRun: boolean;
  durationMs: number;
  runId: string;
  /** Set when the run exited early because another invocation held the lock. */
  lockBusy?: boolean;
  error?: string;
}

export type TelegramMethod = 'sendPhoto' | 'sendVideo' | 'sendMediaGroup' | 'sendMessage' | 'none';
