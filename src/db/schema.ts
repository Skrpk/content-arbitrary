import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * One tenant: a destination channel and the person who reviews for it. The
 * row is the authority on both; one person may review several workspaces.
 */
export const workspaces = pgTable('workspaces', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().default('default'),
  /** The channel. Null while the tenant is being set up; it is then skipped. */
  telegramChatId: text('telegram_chat_id'),
  /**
   * The reviewer's Telegram user id — and their authorisation. For workspace 1
   * both columns are seeded once from TELEGRAM_CHAT_ID / TELEGRAM_ADMIN_CHAT_ID
   * if those are set; the environment never overwrites them afterwards.
   */
  telegramAdminChatId: text('telegram_admin_chat_id'),
  /**
   * When the legacy X_USER_ID / X_USERNAME pair was copied into `sources`.
   *
   * The import must happen exactly once: never again after the admin removes
   * that account, or it would reappear on the next run. This records the fact
   * directly instead of inferring it from a cursor, which cannot distinguish a
   * removed source from an installation that has simply been running since
   * before `sources` existed.
   */
  legacySourceImportedAt: timestamp('legacy_source_imported_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Workspace = typeof workspaces.$inferSelect;

/** The single tenant that exists before multi-tenancy. */
export const DEFAULT_WORKSPACE_ID = 1;

/**
 * Platforms a source can come from.
 *
 * Only X today. The column is deliberately not named `x_...` anywhere, so that
 * adding YouTube, Reddit or RSS later is one enum value plus a fetcher, not a
 * schema reshape.
 */
export const sourcePlatformEnum = pgEnum('source_platform', ['x']);

export type SourcePlatform = (typeof sourcePlatformEnum.enumValues)[number];

/**
 * Accounts the bot watches, managed at runtime from Telegram rather than from
 * environment variables.
 *
 * `external_id` is the canonical identity — an X user id never changes, while a
 * handle can be renamed or taken over by someone else. `username` is therefore
 * cached display data, refreshed when we happen to learn a new one, and is
 * never used to decide whether two rows are the same source.
 *
 * Scoped to a workspace, so a second tenant is a matter of writing a different
 * `workspace_id` rather than reshaping this table.
 */
export const sources = pgTable(
  'sources',
  {
    id: serial('id').primaryKey(),
    workspaceId: integer('workspace_id')
      .notNull()
      .default(DEFAULT_WORKSPACE_ID)
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    platform: sourcePlatformEnum('platform').notNull().default('x'),
    externalId: text('external_id').notNull(),
    username: text('username').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /**
     * Also mirror the account's posts that carry no media at all, as plain
     * text messages. Off by default — the bot began as a media mirror, and an
     * existing source keeps behaving exactly as it did. A post whose media
     * exists but cannot be sent (an HLS-only video, say) is still skipped
     * either way: publishing its text alone would misrepresent it.
     */
    includeTextOnly: boolean('include_text_only').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Scoped per workspace: two tenants may legitimately watch the same account.
    uniqueIndex('sources_workspace_platform_external_id_key').on(
      table.workspaceId,
      table.platform,
      table.externalId,
    ),
    index('sources_enabled_idx').on(table.enabled),
  ],
);

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;

export const postStatusEnum = pgEnum('post_status', [
  'pending',
  'processing',
  'published',
  'failed',
  'skipped',
  /** Sent to the admin for review; waiting for the Approve button. */
  'awaiting_approval',
  /** The admin declined it. Never published, never retried. */
  'rejected',
  /**
   * Approved for a later time; published by the scheduler once
   * `scheduled_for` arrives. Telegram's own scheduled messages are not open to
   * bots, so the queue lives here.
   */
  'scheduled',
]);

export type PostStatus = (typeof postStatusEnum.enumValues)[number];

/**
 * Why a reviewer turned a post down.
 *
 * These values are stored and will be grouped on, so they are a contract:
 * rename the button label freely, but never a value — add a new one instead.
 */
export const REJECTION_REASONS = [
  'not_interesting',
  'wrong_topic',
  'already_covered',
  'too_minor',
  'weak_source',
  'other',
] as const;

export const rejectionReasonEnum = pgEnum('rejection_reason', REJECTION_REASONS);

export type RejectionReason = (typeof REJECTION_REASONS)[number];

export function isRejectionReason(value: string): value is RejectionReason {
  return (REJECTION_REASONS as readonly string[]).includes(value);
}

/**
 * One row per X post we have ever seen.
 *
 * `xPostId` is UNIQUE — this is the hard guarantee against double-publishing.
 * Two concurrent cron invocations both try to INSERT the same post id; exactly
 * one wins and proceeds, the other sees the conflict and backs off.
 */
export const processedPosts = pgTable(
  'processed_posts',
  {
    id: serial('id').primaryKey(),
    workspaceId: integer('workspace_id')
      .notNull()
      .default(DEFAULT_WORKSPACE_ID)
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /**
     * Which source this post came from. Nullable because rows created before
     * sources existed cannot be attributed, and because losing the source must
     * not lose the record that the post was already published.
     */
    sourceId: integer('source_id').references(() => sources.id, { onDelete: 'set null' }),
    /** X post ("tweet") snowflake id, stored as text to avoid 64-bit issues. */
    xPostId: text('x_post_id').notNull(),
    xPostUrl: text('x_post_url').notNull(),
    /** Author handle at the time of processing, for building source links. */
    xAuthorUsername: text('x_author_username'),
    /** Post creation time as reported by X, used to order oldest → newest. */
    xCreatedAt: timestamp('x_created_at', { withTimezone: true }),
    /**
     * The author's own text, whole: the full long-form text where X has one,
     * with t.co links resolved, the link to the post's own media removed and
     * X's HTML entities decoded — plain text, before any prefix, suffix,
     * source link, truncation or escaping of ours. Recorded for every post the
     * moment it is first seen, whatever happens to it afterwards, and never
     * changed. Null on rows that predate the column; empty for a post with no
     * text.
     */
    sourceText: text('source_text'),

    status: postStatusEnum('status').notNull().default('pending'),

    telegramChatId: text('telegram_chat_id'),
    /** Primary (first) Telegram message id; the album rows live in telegram_messages. */
    telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),

    mediaCount: integer('media_count').notNull().default(0),
    /** Which Bot API method was used (or would be used, in DRY_RUN). */
    telegramMethod: text('telegram_method'),

    errorMessage: text('error_message'),
    retryCount: integer('retry_count').notNull().default(0),

    /**
     * Everything needed to publish the post to the channel once the admin
     * approves, captured when it was sent for review.
     *
     * Crucially this holds the Telegram `file_id` of each uploaded asset, so
     * approval re-sends what Telegram already stores instead of downloading
     * from X again — which is both faster and immune to X media URLs expiring
     * between review and approval.
     */
    approvalPayload: jsonb('approval_payload').$type<ApprovalPayload>(),
    /** Message in the admin's private chat carrying the Approve button. */
    adminChatId: text('admin_chat_id'),
    adminMessageId: bigint('admin_message_id', { mode: 'number' }),
    /**
     * When a person decided the post: set on Approve and on Reject, null for a
     * post published straight to the channel with no review. Rows approved
     * before this was recorded have it null as well.
     */
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /**
     * When the reviewer chose to publish it. Kept after publishing, so a
     * post's planned time can be compared with when it actually went out.
     */
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    /**
     * The IANA zone of the reviewer's phone when they scheduled it, used only
     * to show the time back to them as they picked it.
     */
    scheduledTimezone: text('scheduled_timezone'),
    /** Set only on `rejected` rows, and null on those rejected before reasons existed. */
    rejectionReason: rejectionReasonEnum('rejection_reason'),
    /** The reviewer's own words on why, given with the `other` reason. Plain text. */
    rejectionNote: text('rejection_note'),

    /**
     * The caption as it was first sent for review. Written once and never
     * changed afterwards — it is the "before" half of every edit.
     *
     * Both captions are stored in the same escaped Telegram-HTML form the post
     * is published in, so they compare directly; `unescapeHtml` gives the plain
     * text. For a post published with no review both hold the caption it went
     * out with. Null on rows that were never sent anywhere (skipped, failed)
     * or were settled before this column existed; an empty string is a real
     * value — a media-only post with no text.
     */
    originalCaption: text('original_caption'),
    /**
     * The caption the post will be — or was — published with. Equal to
     * `originalCaption` until a reviewer edits it, and the one source of truth
     * for publishing. Unlike `approval_payload` it survives the decision, so the
     * text that actually went out is never lost.
     */
    caption: text('caption'),
    /**
     * When the reviewer last saved a caption in the editor; null if they never
     * did. Saving does not imply a change — compare the two captions for that.
     */
    captionEditedAt: timestamp('caption_edited_at', { withTimezone: true }),

    /**
     * Set when a row moves to `processing`. A row stuck in `processing` past
     * this timestamp + lease window is considered abandoned (the function was
     * killed mid-flight) and may be reclaimed.
     */
    lockedAt: timestamp('locked_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * Duplicate protection, scoped to the tenant. Two workspaces publishing the
     * same X post to their own channels are not duplicates of each other, so
     * the guarantee is per workspace rather than global.
     */
    uniqueIndex('processed_posts_workspace_x_post_id_key').on(table.workspaceId, table.xPostId),
    index('processed_posts_status_idx').on(table.status),
    index('processed_posts_source_idx').on(table.sourceId),
    index('processed_posts_processed_at_idx').on(table.processedAt),
    // The scheduler asks every minute for what is due.
    index('processed_posts_scheduled_idx').on(table.status, table.scheduledFor),
    // A row has both captions or neither: a "current" with no "original" would
    // make every later comparison of the two meaningless.
    check(
      'processed_posts_caption_pair_check',
      sql`(${table.originalCaption} IS NULL) = (${table.caption} IS NULL)`,
    ),
    check(
      'processed_posts_rejection_reason_check',
      sql`${table.rejectionReason} IS NULL OR ${table.status} = 'rejected'`,
    ),
    check(
      'processed_posts_rejection_note_check',
      sql`${table.rejectionNote} IS NULL OR ${table.rejectionReason} IS NOT NULL`,
    ),
  ],
);

/**
 * Telegram returns an array of Message objects for an album, so a single X post
 * can map to up to 10 Telegram messages. We keep them all: it makes the album
 * auditable and lets a future feature edit or delete what we published.
 */
export const telegramMessages = pgTable(
  'telegram_messages',
  {
    id: serial('id').primaryKey(),
    processedPostId: integer('processed_post_id')
      .notNull()
      .references(() => processedPosts.id, { onDelete: 'cascade' }),
    telegramMessageId: bigint('telegram_message_id', { mode: 'number' }).notNull(),
    telegramChatId: text('telegram_chat_id').notNull(),
    /** Position within the album; null for a standalone follow-up text message. */
    mediaIndex: integer('media_index'),
    kind: text('kind').notNull().default('media'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('telegram_messages_post_idx').on(table.processedPostId)],
);

/**
 * Cursor + health for each source. Keeping `lastSeenPostId` lets us pass
 * `since_id` to X, which both reduces our bill (X bills per post read) and
 * keeps us far away from the rate limit.
 */
export const syncState = pgTable(
  'sync_state',
  {
    id: serial('id').primaryKey(),
    workspaceId: integer('workspace_id')
      .notNull()
      .default(DEFAULT_WORKSPACE_ID)
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Stable key for the source within a workspace, e.g. `x:1234567890`. */
    source: text('source').notNull(),
    lastSeenPostId: text('last_seen_post_id'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastSuccessfulSyncAt: timestamp('last_successful_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  /**
   * Scoped per workspace, because `sources` is: two tenants may watch the same
   * account, and a cursor shared between them would let whichever synced first
   * advance `since_id` past posts the other has never seen — a silent loss with
   * no error and no row to recover from.
   */
  (table) => [uniqueIndex('sync_state_workspace_source_key').on(table.workspaceId, table.source)],
);

/** One asset already uploaded to Telegram, addressable by file_id. */
export interface ApprovalMediaItem {
  kind: 'photo' | 'video';
  fileId: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

export interface ApprovalPayload {
  /** `sendMessage` for a text-only post, whose `items` are then empty. */
  method: 'sendPhoto' | 'sendVideo' | 'sendMediaGroup' | 'sendMessage';
  /**
   * Kept in step with `processed_posts.caption`, which is what publishing
   * reads. Still written so that a rollback to code that predates the column
   * publishes the right text.
   */
  caption: string;
  overflowMessage?: string;
  items: ApprovalMediaItem[];
  /**
   * The previewed post in the reviewer's chat — the media message, or the
   * text message of a text-only post — so an edited caption can be shown on
   * the preview they are looking at. Absent on posts queued before editing
   * existed, which is why every use of it is optional.
   */
  adminMediaMessageId?: number;
  /**
   * The preview of `overflowMessage` in the reviewer's chat, so it can be
   * marked as dropped when an edit replaces it. Absent when there was no
   * overflow, its send failed, or the post was queued before it was previewed.
   */
  adminOverflowMessageId?: number;
}

export type ProcessedPost = typeof processedPosts.$inferSelect;
export type NewProcessedPost = typeof processedPosts.$inferInsert;
export type TelegramMessageRow = typeof telegramMessages.$inferSelect;
export type SyncStateRow = typeof syncState.$inferSelect;
