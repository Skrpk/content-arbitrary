import { randomUUID } from 'node:crypto';
import type { Workspace } from '@/db/schema';
import { getDb, getSql, type Database } from '@/lib/db';
import { getEnv, type Env } from '@/lib/env';
import { describeError } from '@/lib/errors';
import { createLogger, type Logger } from '@/lib/logger';
import { TelegramClient } from '@/lib/telegram/client';
import { XClient } from '@/lib/x/client';
import {
  addSource,
  countSources,
  listEnabledSources,
  syncStateKey,
} from '@/lib/sources/repository';
import { acquireSyncLock } from '@/lib/sync/locks';
import { attributePostsToSource, getSyncState } from '@/lib/sync/repository';
import { defaultSleep } from '@/lib/sync/retry';
import { createRadarProvider } from '@/lib/radar/providers';
import { createRadarRun, type RadarRun } from '@/lib/radar/shadow';
import { syncXSource } from '@/lib/sync/sync-x-source';
import {
  channelLabelFor,
  destinationFor,
  ensureDefaultWorkspace,
  listActiveWorkspaces,
  markLegacySourceImported,
} from '@/lib/workspace';
import type { SyncSummary } from '@/types';

/**
 * One complete synchronisation cycle: every tenant, and within a tenant every
 * enabled source.
 *
 * Safety model, in layers:
 *   1. A Postgres advisory lock per tenant means only one invocation syncs a
 *      given tenant at a time. Per tenant rather than global, so one slow
 *      account cannot hold up every other tenant's run.
 *   2. An atomic claim on the UNIQUE (workspace_id, x_post_id) means that even
 *      if the lock were bypassed, a post can only ever be claimed by one runner.
 *   3. Each post is processed in isolation, so one bad post cannot abort a
 *      source; sources and tenants are isolated too, so neither an unreachable
 *      account nor a misconfigured tenant can abort the run.
 *
 * `MAX_POSTS_PER_RUN` applies per source, which is what makes sources
 * independent: adding a busy account cannot starve a quiet one.
 *
 * Every tenant shares one X application, so the bearer token, the rate limit
 * and the per-read cost are installation-wide: two tenants watching the same
 * account keep separate cursors and are therefore billed separately for it.
 */

export interface SyncOptions {
  db?: Database;
  env?: Env;
  logger?: Logger;
  telegramClient?: TelegramClient;
  xClient?: XClient;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides the fetch used for media downloads; injected by tests. */
  fetchImpl?: typeof fetch;
  /** Skip the advisory lock (used by the local CLI runner). */
  skipLock?: boolean;
  /** Overrides Shadow Radar's run (and so its API client); injected by tests. */
  radarRun?: RadarRun;
}

export async function syncPosts(options: SyncOptions = {}): Promise<SyncSummary> {
  const env = options.env ?? getEnv();
  const runId = randomUUID().slice(0, 8);
  const logger = (options.logger ?? createLogger({ app: 'content-arbitrary' })).child({ runId });
  const db = options.db ?? getDb();
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = Date.now();

  const summary: SyncSummary = {
    checked: 0,
    newPosts: 0,
    published: 0,
    awaitingApproval: 0,
    failed: 0,
    skipped: 0,
    sources: [],
    workspaces: 0,
    dryRun: env.DRY_RUN,
    durationMs: 0,
    runId,
  };

  const skippedWorkspaces: { workspaceId: number; reason: string }[] = [];

  logger.info('sync.start', {
    dryRun: env.DRY_RUN,
    maxPostsPerRun: env.MAX_POSTS_PER_RUN,
    includeReplies: env.INCLUDE_REPLIES,
    includeReposts: env.INCLUDE_REPOSTS,
    mediaUploadMode: env.MEDIA_UPLOAD_MODE,
    requireApproval: env.REQUIRE_APPROVAL,
  });

  try {
    const xClient = options.xClient ?? new XClient({ logger });
    const telegramClient = options.telegramClient ?? new TelegramClient({ logger });

    // Shadow Radar only ever scores posts on their way to a reviewer, and only
    // with the configured provider's key set.
    const radarProvider = env.REQUIRE_APPROVAL && !env.DRY_RUN ? createRadarProvider(env) : null;
    const radarRun =
      env.REQUIRE_APPROVAL && !env.DRY_RUN
        ? (options.radarRun ?? (radarProvider ? createRadarRun({ provider: radarProvider }) : null))
        : null;

    // Sources, posts and cursors are all scoped to it, so it has to exist first.
    const defaultWorkspace = await ensureDefaultWorkspace(db, env, logger);

    const tenants = await listActiveWorkspaces(db);
    logger.info('sync.workspaces_loaded', {
      count: tenants.length,
      ids: tenants.map((tenant) => tenant.id),
    });

    // How many channels each reviewer has, so a reviewer of several can be told
    // which one a post is for.
    const channelsPerReviewer = new Map<string, number>();
    for (const tenant of tenants) {
      if (!tenant.telegramAdminChatId) continue;
      const count = channelsPerReviewer.get(tenant.telegramAdminChatId) ?? 0;
      channelsPerReviewer.set(tenant.telegramAdminChatId, count + 1);
    }

    for (const tenant of tenants) {
      const resolved = destinationFor(tenant, env);
      if (!resolved.ok) {
        // A tenant mid-setup, not a failure: nothing of its own is wrong with
        // the run, and the other tenants still get their turn.
        logger.warn('sync.workspace_skipped', { workspaceId: tenant.id, reason: resolved.reason });
        skippedWorkspaces.push({ workspaceId: tenant.id, reason: resolved.reason });
        continue;
      }

      resolved.destination.channelLabel = channelLabelFor(
        tenant,
        channelsPerReviewer.get(tenant.telegramAdminChatId ?? '') ?? 0,
      );

      /**
       * One lock per tenant. A tenant already being synced by an overlapping
       * invocation is skipped rather than waited for: the work is not lost, the
       * in-flight run is already doing it.
       */
      const lock = options.skipLock
        ? { acquired: true, release: async () => {} }
        : await acquireSyncLock(getSql(), `content-arbitrary:sync:${tenant.id}`);

      if (!lock.acquired) {
        logger.warn('sync.lock_busy', { workspaceId: tenant.id });
        skippedWorkspaces.push({ workspaceId: tenant.id, reason: 'another run holds its lock' });
        continue;
      }

      try {
        // Only tenant 1 ever had an environment-configured account to inherit.
        if (tenant.id === defaultWorkspace.id) {
          await bootstrapLegacySource({ db, env, xClient, logger, workspace: tenant });
        }

        const enabled = await listEnabledSources(db, 'x', tenant.id);

        if (enabled.length === 0) {
          logger.warn('sync.no_sources', { workspaceId: tenant.id });
          continue;
        }

        logger.info('sync.sources_loaded', {
          workspaceId: tenant.id,
          count: enabled.length,
          usernames: enabled.map((source) => source.username),
        });

        summary.workspaces += 1;

        for (const source of enabled) {
          // syncXSource never throws; a failure is reported in its summary so
          // the remaining sources and tenants still get their turn.
          const sourceSummary = await syncXSource(source, {
            db,
            env,
            logger,
            xClient,
            telegramClient,
            sleep,
            fetchImpl: options.fetchImpl,
            destination: resolved.destination,
            radar:
              radarRun && tenant.editorialProfile?.trim()
                ? { run: radarRun, profile: tenant.editorialProfile }
                : undefined,
          });

          summary.sources.push(sourceSummary);
          summary.checked += sourceSummary.checked;
          summary.newPosts += sourceSummary.newPosts;
          summary.published += sourceSummary.published;
          summary.awaitingApproval += sourceSummary.awaitingApproval;
          summary.failed += sourceSummary.failed;
          summary.skipped += sourceSummary.skipped;
        }
      } finally {
        await lock.release().catch(() => {});
      }
    }

    if (skippedWorkspaces.length > 0) summary.skippedWorkspaces = skippedWorkspaces;

    const failedSources = summary.sources.filter((source) => source.error);
    if (failedSources.length > 0) {
      // Reported, not thrown: the run did useful work for the other sources.
      summary.error =
        `${failedSources.length} of ${summary.sources.length} source(s) failed: ` +
        failedSources.map((source) => `@${source.username} (${source.error})`).join('; ');
    }

    summary.durationMs = Date.now() - startedAt;
    logger.info('sync.end', { ...summary });
    return summary;
  } catch (error) {
    const message = describeError(error);
    summary.error = message;
    summary.durationMs = Date.now() - startedAt;

    logger.error('sync.failed', { error: message });
    logger.info('sync.end', { ...summary });
    return summary;
  }
}

/**
 * One-time import of the legacy single-account configuration.
 *
 * Before sources lived in the database, the account came from X_USER_ID /
 * X_USERNAME. An existing deployment must keep working after this upgrade
 * without the operator having to do anything, so the legacy pair is copied in
 * the first time a run finds no sources at all.
 *
 * It must never run twice, or an account the admin deliberately removed would
 * reappear. The guard is `workspaces.legacy_source_imported_at`, set as soon as
 * the import succeeds. An earlier version inferred this from the account's
 * `sync_state` row instead, which was wrong in exactly the case this function
 * exists for: an installation running since before `sources` existed already
 * has that cursor, so the import it needed was skipped.
 */
async function bootstrapLegacySource(context: {
  db: Database;
  env: Env;
  xClient: XClient;
  logger: Logger;
  workspace: Workspace;
}): Promise<void> {
  const { db, env, xClient, logger, workspace } = context;

  if (!env.X_USER_ID && !env.X_USERNAME) return;
  if (workspace.legacySourceImportedAt) return;
  if ((await countSources(db)) > 0) return;

  try {
    let externalId = env.X_USER_ID;
    let username = (env.X_USERNAME ?? '').replace(/^@/, '');

    if (!externalId) {
      const user = await xClient.getUserByUsername(username);
      externalId = user.id;
      username = user.username;
    }

    const result = await addSource(db, { platform: 'x', externalId, username: username || externalId });

    // Give the imported account its own publishing history, which predates the
    // sources table and so could not be matched by the migration's back-fill.
    const attributed = await attributePostsToSource(db, {
      sourceId: result.source.id,
      username: result.source.username,
      workspaceId: result.source.workspaceId,
    });

    await markLegacySourceImported(db, result.source.workspaceId);

    logger.info('sources.bootstrap_imported', {
      externalId,
      username: result.source.username,
      created: result.created,
      attributedExistingPosts: attributed,
      resumedFromCursor:
        (await getSyncState(db, syncStateKey(result.source), result.source.workspaceId))
          ?.lastSeenPostId ?? null,
    });
  } catch (error) {
    // A failed import must not stop a run that may still have other work.
    logger.error('sources.bootstrap_failed', { error: describeError(error) });
  }
}
