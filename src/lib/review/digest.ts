import { and, desc, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { processedPosts, storyPosts, type Workspace } from '@/db/schema';
import type { Database } from '@/lib/db';
import { findReviewScores } from '@/lib/radar/review-note';
import { reviewText } from '@/lib/review/text';
import { SITE_NAME } from '@/lib/site';
import { sourceLabelOfPost } from '@/lib/sources/display';
import { escapeHtml, truncateToLength } from '@/lib/telegram/format-caption';
import { parsePostFooter } from '@/lib/telegram/post-footer';

/**
 * The queue notification as an editorial digest: what came in since the last
 * one, grouped into stories, and the stories Radar recommends — best first,
 * each with Radar's own one-line reason and the sources that reported it.
 *
 * It only reads what is already there — Radar's live scores and reasons, the
 * story clustering, the posts' sources — and asks no model anything: a
 * digest costs nothing but a few queries.
 *
 * A story is shown in one digest at most. Its lead post is marked
 * (`processed_posts.digest_sent_at`) when the digest goes out, and a story
 * with a marked post is not recommended again, even when another source
 * reports it later. The queue keeps every post, whatever the digest showed.
 */

/** Stories a digest recommends at most: the strongest, not a second queue. */
export const DIGEST_STORIES_MAX = 5;
/** Posts of a period read at most: as many as the queue page shows. */
const DIGEST_POSTS_MAX = 300;
const TITLE_MAX = 110;
const REASON_MAX = 180;
const SOURCES_SHOWN = 4;

export interface DigestStory {
  /** Its story, or null for a post never placed in one — a story of its own. */
  storyId: number | null;
  /** The post that leads it: its best-scored waiting post, which the link opens. */
  postId: number;
  score: number;
  title: string;
  reason: string | null;
  /** Everyone who reported it, the lead's source first. */
  sources: string[];
}

export interface ReviewDigest {
  /** Posts that joined the queue in the period, decided since or not. */
  newPosts: number;
  /** The stories they make, each counted once. */
  stories: number;
  /** Stories still waiting that Radar expects the editor to take, not in a digest before. */
  recommended: number;
  /** The strongest of those, best first. */
  top: DigestStory[];
}

/**
 * The digest of a workspace's queue for the posts that joined it after
 * `since` — all of them when null.
 */
export async function loadReviewDigest(
  db: Database,
  input: { workspace: Pick<Workspace, 'id' | 'postFooter'>; since: Date | null; limit?: number },
): Promise<ReviewDigest> {
  const limit = input.limit ?? DIGEST_STORIES_MAX;
  const joined = input.since
    ? gt(processedPosts.reviewQueuedAt, input.since)
    : isNotNull(processedPosts.reviewQueuedAt);

  // Every post of the period, and its story — newest first, as many as the queue page shows.
  const rows = await db
    .select({
      id: processedPosts.id,
      status: processedPosts.status,
      externalId: processedPosts.externalId,
      author: processedPosts.xAuthorUsername,
      caption: processedPosts.caption,
      approvalPayload: processedPosts.approvalPayload,
      richDoc: processedPosts.richDoc,
      storyId: storyPosts.storyId,
    })
    .from(processedPosts)
    .leftJoin(storyPosts, eq(storyPosts.processedPostId, processedPosts.id))
    .where(and(eq(processedPosts.workspaceId, input.workspace.id), joined))
    .orderBy(desc(processedPosts.id))
    .limit(DIGEST_POSTS_MAX);

  const keyOf = (row: { id: number; storyId: number | null }) => (row.storyId === null ? `p${row.id}` : `s${row.storyId}`);
  const storyIds = [...new Set(rows.flatMap((row) => (row.storyId === null ? [] : [row.storyId])))];
  const waiting = rows.filter((row) => row.status === 'awaiting_approval');

  const [scores, members] = await Promise.all([
    findReviewScores(
      db,
      waiting.map((row) => row.id),
    ),
    // Every post of those stories, of any period: who reported them, and whether a digest showed them.
    storyIds.length > 0
      ? db
          .select({
            storyId: storyPosts.storyId,
            externalId: processedPosts.externalId,
            author: processedPosts.xAuthorUsername,
            digestSentAt: processedPosts.digestSentAt,
          })
          .from(storyPosts)
          .innerJoin(processedPosts, eq(processedPosts.id, storyPosts.processedPostId))
          .where(and(inArray(storyPosts.storyId, storyIds), eq(processedPosts.workspaceId, input.workspace.id)))
          .orderBy(processedPosts.id)
      : Promise.resolve([]),
  ]);

  const shownBefore = new Set(
    members.filter((member) => member.digestSentAt !== null).map((member) => `s${member.storyId}`),
  );
  const sourcesOf = new Map<string, string[]>();
  for (const member of members) {
    const label = sourceLabelOfPost(member.externalId, member.author);
    if (!label) continue;
    const key = `s${member.storyId}`;
    sourcesOf.set(key, [...new Set([...(sourcesOf.get(key) ?? []), label])]);
  }

  // A story's lead is its best-scored waiting post; the story is recommended when Radar expects it taken.
  const leads = new Map<string, { row: (typeof waiting)[number]; score: NonNullable<ReturnType<typeof scores.get>> }>();
  for (const row of waiting) {
    const score = scores.get(row.id);
    if (!score) continue;
    const key = keyOf(row);
    const lead = leads.get(key);
    if (!lead || score.score > lead.score.score) leads.set(key, { row, score });
  }

  const footer = parsePostFooter(input.workspace.postFooter);
  const recommended = [...leads.entries()]
    .filter(([key, lead]) => lead.score.predictedDecision === 'approve' && !shownBefore.has(key))
    .sort(([, a], [, b]) => b.score.score - a.score.score || a.row.id - b.row.id);

  return {
    newPosts: rows.length,
    stories: new Set(rows.map(keyOf)).size,
    recommended: recommended.length,
    top: recommended.slice(0, limit).map(([key, { row, score }]) => {
      const own = sourceLabelOfPost(row.externalId, row.author);
      const sources = [...new Set([...(own ? [own] : []), ...(sourcesOf.get(key) ?? [])])];
      return {
        storyId: row.storyId,
        postId: row.id,
        score: score.score,
        title: titleOf(reviewText(row, footer)),
        reason: score.reason,
        sources,
      };
    }),
  };
}

/** Mark the stories a digest showed, by their lead posts, so none is shown again. */
export async function markDigested(db: Database, postIds: number[], at: Date): Promise<void> {
  if (postIds.length === 0) return;
  await db.update(processedPosts).set({ digestSentAt: at }).where(inArray(processedPosts.id, postIds));
}

/** A story's title: the first line of its lead post, as the channel will read it. */
function titleOf(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '')?.trim() ?? '';
  return line.length <= TITLE_MAX ? line : `${truncateToLength(line, TITLE_MAX - 1)}…`;
}

/** The digest's words, in the channel's language — English for any it has none in. */
const WORDS = {
  en: {
    period: (span: string) => `last ${span}`,
    since: 'since the last digest',
    minutes: ['minute', 'minutes'],
    hours: ['hour', 'hours'],
    days: ['day', 'days'],
    newPosts: ['new post', 'new posts'],
    stories: ['story', 'stories'],
    recommended: (n: number) => `${n} recommended`,
    sources: 'Sources',
    none: 'No strong stories in this period — Radar recommends none of them.',
    more: (n: number) => `${n} more recommended in the queue.`,
    open: '📋 Open review queue',
  },
  uk: {
    period: (span: string) => `за останні ${span}`,
    since: 'з минулого дайджесту',
    minutes: ['хвилину', 'хвилини', 'хвилин'],
    hours: ['годину', 'години', 'годин'],
    days: ['день', 'дні', 'днів'],
    newPosts: ['новий пост', 'нові пости', 'нових постів'],
    stories: ['історія', 'історії', 'історій'],
    recommended: (n: number) => `${n} ${plural('uk', n, ['рекомендована', 'рекомендовані', 'рекомендованих'])}`,
    sources: 'Джерела',
    none: 'Сильних історій за цей період немає — Radar не рекомендує жодної.',
    more: (n: number) => `Ще ${n} ${plural('uk', n, ['рекомендована', 'рекомендовані', 'рекомендованих'])} — у черзі.`,
    open: '📋 Відкрити чергу',
  },
} as const;

type DigestLanguage = keyof typeof WORDS;

export function digestLanguage(language: string | null): DigestLanguage {
  const code = (language ?? '').toLowerCase().split('-')[0] ?? '';
  return code in WORDS ? (code as DigestLanguage) : 'en';
}

/** The button that opens the queue, in the digest's language. */
export function digestButtonText(language: string | null): string {
  return WORDS[digestLanguage(language)].open;
}

/**
 * `forms` in the order one, few, many (or one, other for English) — Intl's
 * plural rules pick which, so "21 історія", "22 історії", "25 історій".
 */
function plural(language: DigestLanguage, n: number, forms: readonly string[]): string {
  const rule = new Intl.PluralRules(language).select(n);
  if (forms.length === 2) return rule === 'one' ? forms[0]! : forms[1]!;
  return rule === 'one' ? forms[0]! : rule === 'few' ? forms[1]! : forms[2]!;
}

/** "6 hours", "30 minutes", "2 days": the period, rounded as people say it. */
function span(language: DigestLanguage, ms: number): string {
  const words = WORDS[language];
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return `${minutes} ${plural(language, minutes, words.minutes)}`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} ${plural(language, hours, words.hours)}`;
  const days = Math.round(hours / 24);
  return `${days} ${plural(language, days, words.days)}`;
}

/**
 * The digest as a Telegram message (HTML): the channel and period, three
 * counts, the recommended stories numbered as the buttons under it are.
 */
export function formatReviewDigest(
  digest: ReviewDigest,
  input: { language: string | null; channel?: string | null; since: Date | null; now: Date },
): string {
  const language = digestLanguage(input.language);
  const words = WORDS[language];
  const period = input.since ? words.period(span(language, input.now.getTime() - input.since.getTime())) : words.since;
  const header = `📡 <b>${escapeHtml(input.channel?.trim() || SITE_NAME)}</b> — ${period}`;
  const counts = [
    `${digest.newPosts} ${plural(language, digest.newPosts, words.newPosts)}`,
    `${digest.stories} ${plural(language, digest.stories, words.stories)}`,
    words.recommended(digest.recommended),
  ].join(' · ');

  const stories = digest.top.map((story, index) => {
    const lines = [`${index + 1}. <b>${story.score}%</b> — ${escapeHtml(story.title || '…')}`];
    if (story.reason) lines.push(`<i>${escapeHtml(clip(story.reason, REASON_MAX))}</i>`);
    if (story.sources.length > 0) {
      const shown = story.sources.slice(0, SOURCES_SHOWN).join(', ');
      const rest = story.sources.length > SOURCES_SHOWN ? ` +${story.sources.length - SOURCES_SHOWN}` : '';
      lines.push(`${words.sources}: ${escapeHtml(shown)}${rest}`);
    }
    return lines.join('\n');
  });

  const rest = digest.recommended - digest.top.length;
  return [
    header,
    counts,
    ...(stories.length > 0 ? stories : [words.none]),
    ...(rest > 0 ? [words.more(rest)] : []),
  ].join('\n\n');
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${truncateToLength(trimmed, max - 1)}…`;
}
