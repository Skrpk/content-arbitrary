import type { SourceMetadata } from '@/db/schema';
import { truncateForDisplay, truncateToLength } from '@/lib/telegram/format-caption';
import type { ExtractedArticle } from '@/lib/website/article-extractor';
import type { DiscoveredPage } from '@/lib/website/sitemap';
import { sameSite } from '@/lib/website/url';
import type { NormalizedPost } from '@/types';

/**
 * A website's article as a candidate like any other — the shape a YouTube
 * video takes (src/lib/youtube/normalize.ts):
 *
 *   text          its title and lead — what is translated, reviewed and
 *                 published, a post's length;
 *   analysisText  the whole article, bounded — for Radar and the embedding
 *                 only, which read a sample of it; never published.
 *
 * It has no media: the article's pictures are not fetched, and the post goes
 * out with its link, which Telegram previews. Its id is `web:<hash>` of the
 * address the sitemap gave, fixed once found; the link it carries is the
 * page's canonical address when it names a safe one on the same site.
 */

/** Of the article, what a post carries after the title. */
export const WEBSITE_LEAD_MAX = 900;
/** The post's whole text, title included. */
export const WEBSITE_TEXT_MAX = 1500;
/** The article kept for analysis — far more than any sample of it is ever read. */
export const WEBSITE_ANALYSIS_MAX = 60_000;
/** A page's description shorter than this says too little; the article's opening is used instead. */
const MEANINGFUL_EXCERPT = 80;
/** The site's name as the post names it: the page's own, when it gives one this short. */
const AUTHOR_MAX = 80;

export function articleToPost(
  article: ExtractedArticle,
  page: DiscoveredPage & { finalUrl: string },
  source: { username: string },
): NormalizedPost {
  const url = article.canonicalUrl ?? (sameSite(page.finalUrl, page.url) ? page.finalUrl : page.url);
  const siteName = article.siteName && article.siteName.length <= AUTHOR_MAX ? article.siteName : null;

  return {
    platform: 'website',
    id: page.id,
    url,
    authorUsername: siteName ?? source.username,
    // As the page says first; a news sitemap's publication date next; its lastmod only failing both.
    createdAt: article.publishedAt ?? page.published ?? page.lastmod ?? null,
    text: postText(article),
    media: [],
    analysisText: truncateToLength(article.text, WEBSITE_ANALYSIS_MAX),
    sourceMetadata: metadataOf(article, page, url),
    isReply: false,
    isRepost: false,
    isQuote: false,
    metrics: null,
  };
}

/** Title, then the page's own summary — or, when it has none worth the name, the article's opening paragraphs. */
export function postText(article: Pick<ExtractedArticle, 'title' | 'text' | 'excerpt'>): string {
  const title = article.title.trim();
  const excerpt = article.excerpt?.trim() ?? '';
  const lead = excerpt.length >= MEANINGFUL_EXCERPT ? truncateForDisplay(excerpt, WEBSITE_LEAD_MAX) : openingOf(article.text, title);
  return truncateForDisplay([title, lead].filter((part) => part !== '').join('\n\n'), WEBSITE_TEXT_MAX);
}

/** The article's opening paragraphs, up to a lead's worth, without the title again when it opens the text. */
function openingOf(text: string, title: string): string {
  const paragraphs = text.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter((paragraph) => paragraph !== '');
  if (paragraphs[0]?.toLowerCase() === title.toLowerCase()) paragraphs.shift();

  const kept: string[] = [];
  let length = 0;
  for (const paragraph of paragraphs) {
    if (length + paragraph.length > WEBSITE_LEAD_MAX) {
      if (kept.length === 0) kept.push(truncateForDisplay(paragraph, WEBSITE_LEAD_MAX));
      break;
    }
    kept.push(paragraph);
    length += paragraph.length + 2;
  }
  return kept.join('\n\n');
}

function metadataOf(article: ExtractedArticle, page: DiscoveredPage, url: string): SourceMetadata {
  return {
    website: {
      sitemapUrl: page.sitemapUrl,
      originalUrl: url === page.url ? null : page.url,
      canonicalUrl: article.canonicalUrl,
      author: article.byline,
      language: article.lang,
      extractedLength: article.text.length,
      imageUrl: article.imageUrl,
    },
  };
}
