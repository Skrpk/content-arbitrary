/**
 * Read a website's sitemap the way the bot would, and show what it finds —
 * without storing anything, scoring anything or sending anything.
 *
 *   npm run website:check -- https://example.com/sitemap.xml
 *   npm run website:check -- https://example.com/sitemap.xml --extract 3
 *
 * Useful before /addwebsite: it shows whether the URL is a sitemap at all,
 * an index or a list of pages, how many it lists, and the most recent. By
 * default no page is fetched; `--extract N` fetches the N most recent and
 * shows what the article reader makes of each — the post's text, the
 * article's length, or why it is not an article.
 */
import { LARGE_SITEMAP_URLS } from '../src/lib/sources/add-website';
import { fetchArticlePage } from '../src/lib/website/article-client';
import { extractArticle } from '../src/lib/website/article-extractor';
import { articleToPost } from '../src/lib/website/normalize';
import { readSitemapTree } from '../src/lib/website/sitemap';
import { normalizeWebsiteUrl, siteName } from '../src/lib/website/url';

/** Pages `--extract` reads at most: a look at a few, not a crawl. */
const EXTRACT_MAX = 10;

async function main() {
  const input = process.argv[2];
  if (!input || input.startsWith('--')) throw new Error('Usage: npm run website:check -- <sitemap URL> [--extract N]');
  const extractIndex = process.argv.indexOf('--extract');
  const extract = extractIndex === -1 ? 0 : Math.min(EXTRACT_MAX, Math.max(0, Number(process.argv[extractIndex + 1]) || 0));

  const checked = normalizeWebsiteUrl(input);
  if (!checked.ok) throw new Error(checked.reason);

  const tree = await readSitemapTree(checked.url);
  console.log(`Type:    ${tree.kind === 'index' ? 'sitemap index' : 'sitemap'}`);
  console.log(`Host:    ${siteName(checked.url)}`);
  if (tree.kind === 'index') {
    console.log(`Child sitemaps: ${tree.sitemapsFound - 1} (${tree.sitemapsRead - 1} read)`);
  }
  console.log(`URLs discovered: ${tree.pages.length.toLocaleString('en-US')}`);
  if (tree.failures.length > 0) console.log(`Sitemaps that failed: ${tree.failures.length}`);
  if (tree.rejected > 0) console.log(`Addresses left out (another site, or not an address): ${tree.rejected}`);
  if (tree.tooDeep > 0) console.log(`Indexes nested too deep, not read: ${tree.tooDeep}`);
  if (tree.truncated) console.log('Stopped at a limit: there is more than one sync reads.');
  if (tree.pages.length >= LARGE_SITEMAP_URLS || tree.truncated) {
    console.log('⚠️  This sitemap is very large. If the site has a dedicated news or posts sitemap, using that will reduce unnecessary page fetches.');
  }

  // Most recent first, by the sitemap's own dates; pages without one after them.
  const recent = [...tree.pages].sort(
    (a, b) => ((b.published ?? b.lastmod)?.getTime() ?? -Infinity) - ((a.published ?? a.lastmod)?.getTime() ?? -Infinity),
  );
  console.log('');
  console.log('Recent examples:');
  for (const page of recent.slice(0, 10)) {
    const date = (page.published ?? page.lastmod)?.toISOString().slice(0, 10) ?? 'no date   ';
    console.log(`  ${date} ${page.url}`);
  }

  for (const [index, page] of recent.slice(0, extract).entries()) {
    console.log('');
    console.log(`${index + 1}. ${page.url}`);
    try {
      const fetched = await fetchArticlePage(page.url);
      const extraction = extractArticle(fetched.html, fetched.finalUrl);
      if (!extraction.ok) {
        console.log(`   Not an article: ${extraction.reason}`);
        continue;
      }
      const post = articleToPost(extraction.article, { ...page, finalUrl: fetched.finalUrl }, { username: siteName(checked.url) });
      console.log(`   Published: ${post.createdAt?.toISOString().slice(0, 16).replace('T', ' ') ?? 'no date'}`);
      console.log(`   Link:      ${post.url}`);
      console.log(`   Source:    ${post.authorUsername}`);
      console.log(`   Article:   ${extraction.article.text.length.toLocaleString('en-US')} chars${extraction.article.declaredArticle ? ' · declared an article' : ''}`);
      console.log(`   Text (${post.text.length} chars):`);
      for (const line of post.text.split('\n')) console.log(`     ${line}`);
    } catch (error) {
      console.log(`   Could not read it: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

main().catch((error) => {
  console.error('website:check failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
