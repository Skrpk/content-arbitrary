import { productEvents } from '@/db/schema';
import type { Database } from '@/lib/db';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';

/**
 * Record a product event (prd-self-service-onboarding.md §29). Never throws
 * and never fails what it records: a lost event costs a number on a funnel,
 * a failed publish costs a post.
 *
 * Props stay small and carry no one's own words — counts, origins, reasons.
 */

export type ProductEventName =
  | 'onboarding.started'
  | 'onboarding.channel_submitted'
  | 'onboarding.channel_validated'
  | 'onboarding.history_completed'
  | 'onboarding.profile_completed'
  | 'onboarding.discovery_completed'
  | 'onboarding.sources_activated'
  | 'onboarding.source_failed'
  | 'onboarding.completed'
  | 'onboarding.failed'
  | 'onboarding.waitlisted'
  | 'source.removed'
  | 'source.replaced'
  | 'digest.sent'
  | 'queue.opened'
  | 'post.previewed'
  | 'post.rejected'
  | 'post.approved'
  | 'publish.blocked'
  | 'publish.popup_settings'
  | 'channel.check'
  | 'channel.connected'
  | 'profile.saved'
  | 'profile.language_set';

export interface TrackInput {
  userId?: number | null;
  telegramUserId?: string | number | null;
  workspaceId?: number | null;
  sessionId?: number | null;
  props?: Record<string, unknown>;
}

export async function track(db: Database, name: ProductEventName, input: TrackInput = {}, logger?: Logger): Promise<void> {
  try {
    await db.insert(productEvents).values({
      name,
      userId: input.userId ?? null,
      telegramUserId: input.telegramUserId === undefined || input.telegramUserId === null ? null : String(input.telegramUserId),
      workspaceId: input.workspaceId ?? null,
      sessionId: input.sessionId ?? null,
      props: input.props ?? {},
    });
  } catch (error) {
    logger?.warn('analytics.track_failed', { name, error: describeError(error) });
  }
}
