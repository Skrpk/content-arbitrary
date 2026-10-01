import {
  bigint,
  boolean,
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
 * One installation's tenant: a destination channel and the admin who reviews
 * for it.
 *
 * There is exactly one row today, seeded from the environment, and the runtime
 * still reads the channel and admin id from env. It exists now so that the
 * scoping columns below can be added while the tables are small — adding them
 * after a second tenant exists would mean rewriting live data and changing the
 * duplicate-protection constraint under traffic.
 */
export const workspaces = pgTable('workspaces', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().default('default'),
  /** Mirrors TELEGRAM_CHAT_ID; env remains authoritative until tenants land. */
  telegramChatId: text('telegram_chat_id'),
  /** Mirrors TELEGRAM_ADMIN_CHAT_ID. */
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
 * Sources are global to this installation. When ownership arrives, it is an
 * added column (or a join table) rather than a change to anything here.
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
]);

export type PostStatus = (typeof postStatusEnum.enumValues)[number];

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
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),

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
    /** Stable key for the source, e.g. `x:1234567890`. */
    source: text('source').notNull(),
    lastSeenPostId: text('last_seen_post_id'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastSuccessfulSyncAt: timestamp('last_successful_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('sync_state_source_key').on(table.source)],
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
  method: 'sendPhoto' | 'sendVideo' | 'sendMediaGroup';
  caption: string;
  overflowMessage?: string;
  items: ApprovalMediaItem[];
}

export type ProcessedPost = typeof processedPosts.$inferSelect;
export type NewProcessedPost = typeof processedPosts.$inferInsert;
export type TelegramMessageRow = typeof telegramMessages.$inferSelect;
export type SyncStateRow = typeof syncState.$inferSelect;
