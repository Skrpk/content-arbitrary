import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { channelDrafts, processedPosts, type ProcessedPost, type SourcePlatform, type Workspace } from '@/db/schema';
import { messageLink } from '@/lib/drafts/drafts';
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
  /**
   * A post scheduled from the draft channel: it waits there, and what goes out
   * is the post as it is there then — edited in Telegram, not here. Its link
   * opens it in the draft channel.
   */
  draft?: { id: number; link: string | null };
}

/**
 * How many posts wait for their time in these channels — the queue's and the
 * draft channel's alike — for the number beside the Scheduled section.
 */
export async function countScheduledPosts(db: Database, workspaceIds: number[]): Promise<number> {
  if (workspaceIds.length === 0) return 0;
  const [[queued], [drafted]] = await Promise.all([
    db
      .select({ n: count() })
      .from(processedPosts)
      .where(and(inArray(processedPosts.workspaceId, workspaceIds), eq(processedPosts.status, 'scheduled'))),
    db
      .select({ n: count() })
      .from(channelDrafts)
      .where(and(inArray(channelDrafts.workspaceId, workspaceIds), eq(channelDrafts.status, 'scheduled'))),
  ]);
  return (queued?.n ?? 0) + (drafted?.n ?? 0);
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

  const footer = parsePostFooter(workspace.postFooter);
  const drafted = await db
    .select({
      draftId: channelDrafts.id,
      draftChatId: channelDrafts.draftChatId,
      messageIds: channelDrafts.messageIds,
      draftEditedAt: channelDrafts.editedAt,
      draftScheduledFor: channelDrafts.scheduledFor,
      draftTimezone: channelDrafts.scheduledTimezone,
      id: processedPosts.id,
      externalId: processedPosts.externalId,
      xPostUrl: processedPosts.xPostUrl,
      xAuthorUsername: processedPosts.xAuthorUsername,
      caption: processedPosts.caption,
      approvalPayload: processedPosts.approvalPayload,
      reviewMedia: processedPosts.reviewMedia,
      sourceMetadata: processedPosts.sourceMetadata,
      richDoc: processedPosts.richDoc,
    })
    .from(channelDrafts)
    .innerJoin(processedPosts, eq(processedPosts.id, channelDrafts.processedPostId))
    .where(and(eq(channelDrafts.workspaceId, workspace.id), eq(channelDrafts.status, 'scheduled')))
    .orderBy(asc(channelDrafts.scheduledFor))
    .limit(SCHEDULED_PAGE_LIMIT);
  const fromDrafts = drafted.flatMap((row): ScheduledItem[] =>
    row.draftScheduledFor
      ? [
          {
            id: row.id,
            platform: platformOfPostId(row.externalId),
            sourceLabel: sourceLabelOfPost(row.externalId, row.xAuthorUsername),
            url: row.xPostUrl,
            text: reviewText(row, footer),
            media: shownMedia(row),
            scheduledFor: row.draftScheduledFor.toISOString(),
            display: formatScheduleTime(row.draftScheduledFor, row.draftTimezone),
            edited: row.draftEditedAt !== null,
            rich: row.richDoc !== null,
            draft: { id: row.draftId, link: row.messageIds[0] ? messageLink(row.draftChatId, row.messageIds[0]) : null },
          },
        ]
      : [],
  );

  return [...fromQueue(rows, footer), ...fromDrafts]
    .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor) || a.id - b.id)
    .slice(0, SCHEDULED_PAGE_LIMIT);
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
