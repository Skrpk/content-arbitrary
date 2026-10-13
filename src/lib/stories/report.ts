import { asc, eq } from 'drizzle-orm';
import { processedPosts, storyPosts, stories, type PostStatus, type RejectionReason } from '@/db/schema';
import { APPROVED_STATUSES } from '@/lib/radar/repository';
import { sourceLabelOfPost } from '@/lib/sources/display';
import type { Db } from '@/lib/stories/cluster';

/**
 * What the clustering made of a workspace's posts, for judging it by eye and
 * by the editor's own decisions: how many stories have more than one post,
 * whether the editor published one story twice, and whether the posts they
 * turned down as already covered sit in a story they had already published.
 */

export interface StoryReportRow {
  storyId: number;
  processedPostId: number;
  arrivedAt: Date;
  source: string | null;
  text: string | null;
  status: PostStatus;
  rejectionReason: RejectionReason | null;
  similarity: number | null;
  threshold: number;
}

export async function loadStoryReportRows(db: Db, workspaceId: number): Promise<StoryReportRow[]> {
  const rows = await db
    .select({
      storyId: storyPosts.storyId,
      processedPostId: processedPosts.id,
      arrivedAt: processedPosts.createdAt,
      externalId: processedPosts.externalId,
      author: processedPosts.xAuthorUsername,
      text: processedPosts.sourceText,
      status: processedPosts.status,
      rejectionReason: processedPosts.rejectionReason,
      similarity: storyPosts.similarity,
      threshold: storyPosts.threshold,
    })
    .from(storyPosts)
    .innerJoin(stories, eq(stories.id, storyPosts.storyId))
    .innerJoin(processedPosts, eq(processedPosts.id, storyPosts.processedPostId))
    .where(eq(stories.workspaceId, workspaceId))
    .orderBy(asc(processedPosts.createdAt), asc(processedPosts.id));
  return rows.map(({ externalId, author, ...row }) => ({ ...row, source: sourceLabelOfPost(externalId, author) }));
}

const BANDS = [0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6];

export function formatStoryReport(rows: StoryReportRow[], options: { show?: number } = {}): string {
  if (rows.length === 0) return 'No posts placed in stories yet.';

  const byStory = new Map<number, StoryReportRow[]>();
  for (const row of rows) byStory.set(row.storyId, [...(byStory.get(row.storyId) ?? []), row]);
  const grouped = [...byStory.values()].filter((posts) => posts.length > 1);
  const inGroups = grouped.reduce((total, posts) => total + posts.length, 0);
  const approved = (row: StoryReportRow) => (APPROVED_STATUSES as readonly string[]).includes(row.status);
  const sourcesOf = (posts: StoryReportRow[]) => new Set(posts.map((row) => row.source)).size;

  const lines = [
    `${rows.length} posts in ${byStory.size} stories`,
    `Stories of 2+ posts: ${grouped.length}, holding ${inGroups} posts (${percent(inGroups, rows.length)}); ` +
      `from 2+ sources: ${grouped.filter((posts) => sourcesOf(posts) > 1).length}; ` +
      `largest: ${Math.max(...grouped.map((posts) => posts.length), 1)}`,
  ];

  // Every placed post's nearest earlier post, joined or not — what the threshold cut.
  const nearest = rows.map((row) => row.similarity).filter((value): value is number => value !== null);
  const thresholds = [...new Set(rows.map((row) => row.threshold))].join(', ');
  lines.push(`\nNearest earlier post, by similarity (threshold ${thresholds}):`);
  let upper = Infinity;
  for (const band of [...BANDS, -Infinity]) {
    const count = nearest.filter((value) => value >= band && value < upper).length;
    lines.push(`  ${band === -Infinity ? `< ${BANDS.at(-1)}` : `≥ ${band.toFixed(2)}`}`.padEnd(10) + String(count));
    upper = band;
  }
  lines.push(`  none in window`.padEnd(10) + String(rows.length - nearest.length));

  const twicePublished = grouped.filter((posts) => posts.filter(approved).length > 1);
  const covered = rows.filter((row) => row.rejectionReason === 'already_covered');
  const earlier = (row: StoryReportRow, which: (other: StoryReportRow) => boolean) =>
    byStory.get(row.storyId)!.some((other) => which(other) && other.arrivedAt < row.arrivedAt);
  const followed = covered.filter((row) => earlier(row, () => true));
  const caught = covered.filter((row) => earlier(row, approved));
  lines.push(
    `\nThe editor's decisions:`,
    `  Stories with 2+ posts published: ${twicePublished.length}` +
      (twicePublished.length > 0 ? ` (stories ${twicePublished.map((posts) => posts[0]!.storyId).join(', ')})` : ''),
    `  'Already covered' rejections: ${covered.length}; in a story with an earlier post: ${followed.length}, ` +
      `one already published: ${caught.length}`,
  );

  const shown = [...grouped]
    .sort((a, b) => b.length - a.length || b.at(-1)!.arrivedAt.getTime() - a.at(-1)!.arrivedAt.getTime())
    .slice(0, options.show ?? 25);
  if (shown.length > 0) lines.push(`\nLargest stories (${shown.length} of ${grouped.length}):`);
  for (const posts of shown) {
    lines.push(`\n#${posts[0]!.storyId} · ${posts.length} posts · ${sourcesOf(posts)} sources`);
    for (const [index, row] of posts.entries()) {
      const similarity = index === 0 ? '    ' : (row.similarity ?? 0).toFixed(2);
      lines.push(
        `  ${row.arrivedAt.toISOString().slice(5, 16).replace('T', ' ')}  ${similarity}  ${statusLabel(row).padEnd(9)} ` +
          `${(row.source ?? '?').slice(0, 22).padEnd(22)}  ${snippet(row.text)}`,
      );
    }
  }
  return lines.join('\n');
}

function statusLabel(row: StoryReportRow): string {
  if (row.status === 'published' || row.status === 'scheduled') return 'published';
  if (row.status === 'rejected') return row.rejectionReason === 'already_covered' ? 'repeat' : 'rejected';
  if (row.status === 'awaiting_approval') return 'in review';
  return row.status;
}

function snippet(text: string | null): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 79)}…`;
}

function percent(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${Math.round((part / whole) * 100)}%`;
}
