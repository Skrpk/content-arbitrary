import { and, asc, eq } from 'drizzle-orm';
import { processedPosts, type SourcePlatform, type Workspace } from '@/db/schema';
import type { Database } from '@/lib/db';
import { reviewText } from '@/lib/review/text';
import { platformOfPostId, sourceLabelOfPost } from '@/lib/sources/display';
import { formatScheduleTime } from '@/lib/sync/approval';
import { parsePostFooter } from '@/lib/telegram/post-footer';

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
      captionEditedAt: processedPosts.captionEditedAt,
      richDoc: processedPosts.richDoc,
      scheduledFor: processedPosts.scheduledFor,
      scheduledTimezone: processedPosts.scheduledTimezone,
    })
    .from(processedPosts)
    .where(and(eq(processedPosts.workspaceId, workspace.id), eq(processedPosts.status, 'scheduled')))
    .orderBy(asc(processedPosts.scheduledFor), asc(processedPosts.id))
    .limit(SCHEDULED_PAGE_LIMIT);

  const footer = parsePostFooter(workspace.postFooter);
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
        media: (row.reviewMedia ?? []).map((item) => ({
          kind: item.kind,
          imageUrl: (item.kind === 'photo' ? item.url : item.previewUrl) ?? null,
        })),
        scheduledFor: row.scheduledFor.toISOString(),
        display: formatScheduleTime(row.scheduledFor, row.scheduledTimezone),
        edited: row.captionEditedAt !== null,
        rich: row.richDoc !== null,
      },
    ];
  });
}
