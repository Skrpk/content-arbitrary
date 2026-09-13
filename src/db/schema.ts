import {
  bigint,
  index,
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const postStatusEnum = pgEnum('post_status', [
  'pending',
  'processing',
  'published',
  'failed',
  'skipped',
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
    uniqueIndex('processed_posts_x_post_id_key').on(table.xPostId),
    index('processed_posts_status_idx').on(table.status),
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

export type ProcessedPost = typeof processedPosts.$inferSelect;
export type NewProcessedPost = typeof processedPosts.$inferInsert;
export type TelegramMessageRow = typeof telegramMessages.$inferSelect;
export type SyncStateRow = typeof syncState.$inferSelect;
