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
  /** animated_gif is delivered by X as a silent MP4; we send it as a video. */
  wasAnimatedGif?: boolean;
}

/** An X post reduced to only what the publisher needs. */
export interface NormalizedPost {
  id: string;
  url: string;
  authorUsername: string;
  createdAt: Date | null;
  /** Post text with t.co noise already resolved/removed. */
  text: string;
  media: NormalizedMedia[];
  isReply: boolean;
  isRepost: boolean;
  isQuote: boolean;
}

export interface SyncSummary {
  checked: number;
  newPosts: number;
  published: number;
  failed: number;
  skipped: number;
  dryRun: boolean;
  durationMs: number;
  runId: string;
  /** Set when the run exited early because another invocation held the lock. */
  lockBusy?: boolean;
  error?: string;
}

export type TelegramMethod = 'sendPhoto' | 'sendVideo' | 'sendMediaGroup' | 'sendMessage' | 'none';
