import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { processedPosts, type ProcessedPost, type SourcePlatform, type Workspace } from '@/db/schema';
import type { Database } from '@/lib/db';
import { reviewText } from '@/lib/review/text';
import { platformOfPostId, sourceLabelOfPost } from '@/lib/sources/display';
import { formatScheduleTime } from '@/lib/sync/approval';
import { parsePostFooter } from '@/lib/telegram/post-footer';
import { shownMedia } from '@/lib/review/media';

/**
 * A channel's scheduled posts as the website's Scheduled page shows them:
 * approved for a set time and not gone out yet, soonest first. Their text
 * may still change and their time may still move — the scheduler reads both
 * only when the time comes.
 */

/** Posts the page shows at most; a channel with more is planning far ahead. */
export const SCHEDULED_PAGE_LIMIT = 200;

export interface ScheduledItem {
  id: number;
  platform: SourcePlatform;
  sourceLabel: string | null;
  url: string;
  /** The text it will be published with, as plain text, without the channel's footer. */
  text: string;
  media: { kind: 'photo' | 'video'; imageUrl: string | null }[];
  /** When it goes out, as an exact moment. */
  scheduledFor: string;
  /** That moment as the reviewer picked it, in their zone. */
  display: string;
  edited: boolean;
  rich: boolean;
}

/** How many posts wait for their time in these channels, for the number beside the Scheduled section. */
export async function countScheduledPosts(db: Database, workspaceIds: number[]): Promise<number> {
  if (workspaceIds.length === 0) return 0;
  const [queued] = await db
    .select({ n: count() })
    .from(processedPosts)
    .where(and(inArray(processedPosts.workspaceId, workspaceIds), eq(processedPosts.status, 'scheduled')));
  return queued?.n ?? 0;
}

export async function loadScheduledPosts(
  db: Database,
  workspace: Pick<Workspace, 'id' | 'postFooter'>,
): Promise<ScheduledItem[]> {
  const rows = await db
    .select({
      id: processedPosts.id,
      externalId: processedPosts.externalId,
      xPostUrl: processedPosts.xPostUrl,
      xAuthorUsername: processedPosts.xAuthorUsername,
      caption: processedPosts.caption,
      approvalPayload: processedPosts.approvalPayload,
      reviewMedia: processedPosts.reviewMedia,
      sourceMetadata: processedPosts.sourceMetadata,
      captionEditedAt: processedPosts.captionEditedAt,
      richDoc: processedPosts.richDoc,
      scheduledFor: processedPosts.scheduledFor,
      scheduledTimezone: processedPosts.scheduledTimezone,
    })
    .from(processedPosts)
    .where(and(eq(processedPosts.workspaceId, workspace.id), eq(processedPosts.status, 'scheduled')))
    .orderBy(asc(processedPosts.scheduledFor), asc(processedPosts.id))
    .limit(SCHEDULED_PAGE_LIMIT);

  return fromQueue(rows, parsePostFooter(workspace.postFooter));
}

function fromQueue(
  rows: (Pick<ProcessedPost, 'id' | 'externalId' | 'xPostUrl' | 'xAuthorUsername' | 'caption' | 'approvalPayload' | 'reviewMedia' | 'sourceMetadata' | 'captionEditedAt' | 'richDoc' | 'scheduledFor' | 'scheduledTimezone'>)[],
  footer: ReturnType<typeof parsePostFooter>,
): ScheduledItem[] {
  return rows.flatMap((row): ScheduledItem[] => {
    // A scheduled post always has its time; one without would never go out.
    if (!row.scheduledFor) return [];
    return [
      {
        id: row.id,
        platform: platformOfPostId(row.externalId),
        sourceLabel: sourceLabelOfPost(row.externalId, row.xAuthorUsername),
        url: row.xPostUrl,
        text: reviewText(row, footer),
        media: shownMedia(row),
        scheduledFor: row.scheduledFor.toISOString(),
        display: formatScheduleTime(row.scheduledFor, row.scheduledTimezone),
        edited: row.captionEditedAt !== null,
        rich: row.richDoc !== null,
      },
    ];
  });
}
