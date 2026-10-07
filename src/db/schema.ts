import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
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
  /**
   * What this channel publishes and what its editor turns down, in the
   * editor's words. Shadow Radar scores posts against it; null leaves Radar
   * off for the tenant.
   */
  editorialProfile: text('editorial_profile'),
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

    /**
     * The post's public engagement as X reported it when we first fetched it,
     * at `x_metrics_at` — a snapshot for analysis, never refreshed, so read it
     * together with the post's age then (`x_metrics_at - x_created_at`). Null
     * on rows that predate the columns, or where X sent no count.
     */
    xLikeCount: integer('x_like_count'),
    xRepostCount: integer('x_repost_count'),
    xReplyCount: integer('x_reply_count'),
    xQuoteCount: integer('x_quote_count'),
    xBookmarkCount: integer('x_bookmark_count'),
    xImpressionCount: bigint('x_impression_count', { mode: 'number' }),
    xMetricsAt: timestamp('x_metrics_at', { withTimezone: true }),

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
    /**
     * The media the reviewer was shown, kept after the decision — unlike
     * approval_payload, which is dropped once the post is published or
     * rejected. Radar's backfill needs it to show a model the picture the
     * editor saw. Null on posts reviewed before the column existed.
     */
    reviewMedia: jsonb('review_media').$type<ReviewMediaItem[]>(),
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

export const RADAR_MODES = ['live', 'backfill'] as const;
export type RadarMode = (typeof RADAR_MODES)[number];

/** What Radar was shown: the text alone, or the text and the post's first image. */
export const RADAR_VARIANTS = ['text', 'text_image'] as const;
export type RadarVariant = (typeof RADAR_VARIANTS)[number];

export const RADAR_STATUSES = ['ok', 'failed', 'skipped'] as const;
export type RadarStatus = (typeof RADAR_STATUSES)[number];

/**
 * Shadow Radar's predictions: how likely the editor is to publish a post.
 *
 * Recorded, never shown to the reviewer and never acted on — the experiment is
 * whether the prediction matches the decision the editor then makes on their
 * own. A `live` row is written before the post is sent for review, so it is an
 * honest prediction; a `backfill` row was scored afterwards, from history, and
 * must never be counted with the live ones.
 *
 * A failed or skipped attempt is a row too, so coverage can be measured rather
 * than hidden behind the scores that did come back.
 */
export const radarEvaluations = pgTable(
  'radar_evaluations',
  {
    id: serial('id').primaryKey(),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    processedPostId: integer('processed_post_id')
      .notNull()
      .references(() => processedPosts.id, { onDelete: 'cascade' }),
    mode: text('mode', { enum: RADAR_MODES }).notNull(),
    variant: text('variant', { enum: RADAR_VARIANTS }).notNull(),
    status: text('status', { enum: RADAR_STATUSES }).notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),

    /** 0–100: how likely the editor is to publish it. Null unless `ok`. */
    score: integer('score'),
    predictedDecision: text('predicted_decision', { enum: ['approve', 'reject'] }),
    topicFit: integer('topic_fit'),
    editorialFit: integer('editorial_fit'),
    importance: integer('importance'),
    reason: text('reason'),
    predictedRejectionReason: rejectionReasonEnum('predicted_rejection_reason'),

    /** Whether an image actually went with the text_image variant. */
    imageIncluded: boolean('image_included').notNull().default(false),
    /** The past decisions shown as examples, so a miss can be traced to its context. */
    examplePostIds: integer('example_post_ids').array().notNull().default(sql`'{}'::integer[]`),

    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms'),
    error: text('error'),
    /**
     * The publication-history profile the prompt carried, if any — so a score
     * can be traced to the exact context it was made with.
     */
    publicationHistoryProfileId: integer('publication_history_profile_id'),
    /**
     * The similar past publications the prompt carried, and how the search for
     * them went — null for a prompt version that does not retrieve them.
     */
    historyRetrieval: jsonb('history_retrieval').$type<HistoryRetrievalRecord>(),
    /** What the model said about those publications, when the prompt asked. */
    historicalAssessment: jsonb('historical_assessment').$type<HistoricalAssessment>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Named here: the generated name is longer than Postgres's 63 characters.
    foreignKey({
      name: 'radar_evaluations_history_profile_id_fk',
      columns: [table.publicationHistoryProfileId],
      foreignColumns: [publicationHistoryProfiles.id],
    }).onDelete('set null'),
    index('radar_evaluations_history_profile_idx').on(table.publicationHistoryProfileId),
    // One prediction per post per setup: a retried post is not scored twice.
    uniqueIndex('radar_evaluations_post_setup_key').on(
      table.processedPostId,
      table.mode,
      table.variant,
      table.model,
      table.promptVersion,
    ),
    index('radar_evaluations_workspace_idx').on(table.workspaceId),
    check('radar_evaluations_mode_check', sql`${table.mode} IN ('live', 'backfill')`),
    check('radar_evaluations_variant_check', sql`${table.variant} IN ('text', 'text_image')`),
    check('radar_evaluations_status_check', sql`${table.status} IN ('ok', 'failed', 'skipped')`),
    check(
      'radar_evaluations_prediction_check',
      sql`${table.status} <> 'ok' OR (${table.score} BETWEEN 0 AND 100 AND ${table.predictedDecision} IN ('approve', 'reject'))`,
    ),
  ],
);

export type RadarEvaluation = typeof radarEvaluations.$inferSelect;

/**
 * How the search for a post's similar past publications went: `ok` with the
 * matches shown, or why there were none — the post has no text, the
 * workspace has no embedded history from before the post, embeddings are not
 * configured, or the search failed and the post was scored without it.
 */
export const HISTORY_RETRIEVAL_STATUSES = ['ok', 'no_text', 'no_history', 'unavailable', 'failed'] as const;
export type HistoryRetrievalStatus = (typeof HISTORY_RETRIEVAL_STATUSES)[number];

export interface HistoryRetrievalRecord {
  status: HistoryRetrievalStatus;
  /** Null when no embedding model was configured. */
  embeddingModel: string | null;
  /** `publication_history_items` ids, most similar first, with cosine similarity. */
  matches: { id: number; similarity: number }[];
  /**
   * The approved-posts prompt only: the search among posts the editor had
   * already approved — `processed_posts` ids, most similar first. `status`
   * above covers history; this has its own, as either can be empty alone.
   */
  approved?: { status: HistoryRetrievalStatus; matches: { id: number; similarity: number }[] };
  error?: string;
}

export interface HistoricalAssessment {
  relevant: boolean;
  possiblyAlreadyCovered: boolean;
  explanation: string;
}

/** What kind of thing a publication put out. Platform-neutral on purpose. */
export const HISTORY_CONTENT_TYPES = [
  'post',
  'newsletter_issue',
  'article',
  'video',
  'podcast_episode',
  'other',
] as const;
export type HistoryContentType = (typeof HISTORY_CONTENT_TYPES)[number];

export const HISTORY_IMPORT_STATUSES = ['processing', 'completed', 'failed'] as const;
export type HistoryImportStatus = (typeof HISTORY_IMPORT_STATUSES)[number];

/** One attachment of a historical item: what it was, never the file itself. */
export interface HistoricalMediaItem {
  type: 'photo' | 'video' | 'audio' | 'document' | 'animation' | 'sticker' | 'other';
  /** Where the file sits inside the export, if the export included it. */
  relativePath: string | null;
  /** False when the export names the file but left it out. */
  available: boolean;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  fileSizeBytes?: number | null;
}

/**
 * One run of a history import: who loaded what into which workspace, and how
 * it went. Written before anything is parsed, so a failed import leaves a
 * record too.
 */
export const publicationHistoryImports = pgTable(
  'publication_history_imports',
  {
    id: serial('id').primaryKey(),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** The adapter that read the file, e.g. `telegram-json`. */
    adapter: text('adapter').notNull(),
    /** Known once the file is parsed; null if parsing failed. */
    platform: text('platform'),
    publicationKey: text('publication_key'),
    originalFilename: text('original_filename').notNull(),
    fileSha256: text('file_sha256').notNull(),
    status: text('status', { enum: HISTORY_IMPORT_STATUSES }).notNull().default('processing'),
    itemsSeen: integer('items_seen').notNull().default(0),
    itemsImported: integer('items_imported').notNull().default(0),
    itemsUpdated: integer('items_updated').notNull().default(0),
    /** Already stored exactly as the file has them. */
    itemsUnchanged: integer('items_unchanged').notNull().default(0),
    itemsSkipped: integer('items_skipped').notNull().default(0),
    itemsFailed: integer('items_failed').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    errorMessage: text('error_message'),
    /** Skip reasons, warnings and what the export says about the publication. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  },
  (table) => [
    index('publication_history_imports_workspace_idx').on(table.workspaceId),
    check(
      'publication_history_imports_status_check',
      sql`${table.status} IN ('processing', 'completed', 'failed')`,
    ),
  ],
);

export type PublicationHistoryImport = typeof publicationHistoryImports.$inferSelect;

/**
 * What a workspace itself has published in the past — its channel's posts, and
 * later its newsletter issues, articles or videos — imported from an export.
 *
 * Not to be confused with `sources` (accounts the bot watches) or
 * `processed_posts` (what it found there and put through review): this is the
 * publication's own back catalogue.
 *
 * Platform-specific identity lives in `platform` + `publication_key` +
 * `external_id`, never in columns named for one platform, so one workspace can
 * hold a Telegram channel's history beside a newsletter's.
 */
export const publicationHistoryItems = pgTable(
  'publication_history_items',
  {
    id: serial('id').primaryKey(),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Where it was published: `telegram` today. */
    platform: text('platform').notNull(),
    /** Which channel, newsletter or feed on that platform. */
    publicationKey: text('publication_key').notNull(),
    /** The item's id on the platform, as text whatever its native type. */
    externalId: text('external_id').notNull(),
    contentType: text('content_type', { enum: HISTORY_CONTENT_TYPES }).notNull(),
    title: text('title'),
    /** Plain text, formatting removed: what a reader would read. */
    text: text('text'),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    /** Only when the export allows building it reliably; never guessed. */
    canonicalUrl: text('canonical_url'),
    media: jsonb('media').$type<HistoricalMediaItem[]>().notNull().default(sql`'[]'::jsonb`),
    metrics: jsonb('metrics').$type<Record<string, unknown>>(),
    /** Useful provenance from the source, not the whole raw record. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    /** The import that last inserted or changed this row. */
    importId: integer('import_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Named here: the generated name is longer than Postgres's 63 characters.
    foreignKey({
      name: 'publication_history_items_import_id_fk',
      columns: [table.importId],
      foreignColumns: [publicationHistoryImports.id],
    }).onDelete('set null'),
    // Re-importing the same export, or a later one that overlaps it, updates
    // rows instead of duplicating them.
    uniqueIndex('publication_history_items_identity_key').on(
      table.workspaceId,
      table.platform,
      table.publicationKey,
      table.externalId,
    ),
    check(
      'publication_history_items_content_type_check',
      sql`${table.contentType} IN ('post', 'newsletter_issue', 'article', 'video', 'podcast_episode', 'other')`,
    ),
  ],
);

export type PublicationHistoryItem = typeof publicationHistoryItems.$inferSelect;

/**
 * A compact, structured portrait of what a workspace's publication history
 * shows the channel publishes — its topics, angles, tone and format — distilled
 * by a model from `publication_history_items`. Shadow Radar reads the newest
 * one as background context.
 *
 * Append-only: a profile is never edited; a new one is generated when history
 * or the profiling prompt changes. `source_fingerprint` + `prompt_version` +
 * `model` identify what it was made from, so an unchanged history is not
 * profiled twice. `history_cutoff_at` is the newest publication it saw: a
 * profile may only inform a prediction about a post that arrived after it.
 */
export const publicationHistoryProfiles = pgTable(
  'publication_history_profiles',
  {
    id: serial('id').primaryKey(),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Validated on read against the profile schema in src/lib/history/profile. */
    profile: jsonb('profile').$type<Record<string, unknown>>().notNull(),
    /** History items the profile was made from. */
    sourceItemCount: integer('source_item_count').notNull(),
    sourceFingerprint: text('source_fingerprint').notNull(),
    historyCutoffAt: timestamp('history_cutoff_at', { withTimezone: true }).notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** How it was made: batches, model calls, what the history held. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('publication_history_profiles_workspace_idx').on(table.workspaceId, table.historyCutoffAt),
    index('publication_history_profiles_fingerprint_idx').on(table.workspaceId, table.sourceFingerprint),
  ],
);

export type PublicationHistoryProfileRow = typeof publicationHistoryProfiles.$inferSelect;

/**
 * A pgvector `vector` of any length. Deliberately without a fixed dimension:
 * each row records its model and `dimensions`, and every search filters on
 * both, so vectors of different models are never compared — and trying
 * text-embedding-3-large (3072) beside text-embedding-3-small (1536) needs no
 * migration. The cost is that an approximate (HNSW) index, which needs a fixed
 * dimension, would have to be a per-model expression index; searches are
 * exact scans, which a workspace's history is small enough for.
 */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (value) => `[${value.join(',')}]`,
  fromDriver: (value) => JSON.parse(value) as number[],
});

/**
 * Text embeddings of publication history items, one per item per embedding
 * model, for finding the past publications most similar to a new post.
 *
 * `content_fingerprint` hashes the exact text that was embedded: when an item's
 * title or text changes on a later import, the fingerprint no longer matches
 * and the item is embedded again; otherwise the vector is reused. Items with no
 * text (photo- or video-only) have no row.
 */
export const publicationHistoryEmbeddings = pgTable(
  'publication_history_embeddings',
  {
    id: serial('id').primaryKey(),
    publicationHistoryItemId: integer('publication_history_item_id').notNull(),
    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    contentFingerprint: text('content_fingerprint').notNull(),
    embedding: vector('embedding').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Named here: the generated name is longer than Postgres's 63 characters.
    foreignKey({
      name: 'publication_history_embeddings_item_id_fk',
      columns: [table.publicationHistoryItemId],
      foreignColumns: [publicationHistoryItems.id],
    }).onDelete('cascade'),
    uniqueIndex('publication_history_embeddings_item_model_key').on(
      table.publicationHistoryItemId,
      table.model,
    ),
    check('publication_history_embeddings_dimensions_check', sql`vector_dims(${table.embedding}) = ${table.dimensions}`),
  ],
);

/**
 * The embedding of a processed post's text: as a candidate, what Radar
 * searches with — kept so a backfill can reproduce, when it reads results
 * back, exactly the search its requests were built from, and so a post is not
 * embedded twice; once the editor approves it, what later candidates are
 * compared with to spot a repeat. `npm run history:embed` fills it in for
 * posts that were never searched with.
 */
export const radarCandidateEmbeddings = pgTable(
  'radar_candidate_embeddings',
  {
    id: serial('id').primaryKey(),
    processedPostId: integer('processed_post_id').notNull(),
    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    contentFingerprint: text('content_fingerprint').notNull(),
    embedding: vector('embedding').notNull(),
    inputTokens: integer('input_tokens'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Named here: the generated name is longer than Postgres's 63 characters.
    foreignKey({
      name: 'radar_candidate_embeddings_post_id_fk',
      columns: [table.processedPostId],
      foreignColumns: [processedPosts.id],
    }).onDelete('cascade'),
    uniqueIndex('radar_candidate_embeddings_post_model_key').on(table.processedPostId, table.model),
    check('radar_candidate_embeddings_dimensions_check', sql`vector_dims(${table.embedding}) = ${table.dimensions}`),
  ],
);

/** One media item of a reviewed post, as far as it is known. */
export interface ReviewMediaItem {
  kind: 'photo' | 'video';
  /** Telegram's copy, from the review send; the reliable one to fetch. */
  fileId?: string;
  /** X's URL of a photo. */
  url?: string;
  /** X's still image of a video. */
  previewUrl?: string;
}

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
