/**
 * Read a feed the way the bot would, and show what it makes of it — without
 * storing anything, scoring anything or sending anything.
 *
 *   npm run rss:check -- https://example.com/feed.xml
 *
 * Useful before /addrss: it shows whether the URL is a feed at all, its
 * title, and the newest entries as they would reach review.
 */
import { fetchFeed } from '../src/lib/rss/client';
import { entryToPost, oldestFirst } from '../src/lib/rss/normalize';
import { parseFeed } from '../src/lib/rss/parser';
import { normalizeFeedUrl } from '../src/lib/rss/url';

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error('Usage: npm run rss:check -- <feed URL>');

  const checked = normalizeFeedUrl(input);
  if (!checked.ok) throw new Error(checked.reason);

  const fetched = await fetchFeed(checked.url);
  const feed = parseFeed(fetched.xml, fetched.finalUrl);
  const name = feed.title ?? new URL(checked.url).hostname;

  console.log(`Feed:    ${name}`);
  console.log(`Type:    ${feed.format === 'atom' ? 'Atom 1.0' : 'RSS 2.0'}`);
  console.log(`URL:     ${checked.url}${fetched.finalUrl !== checked.url ? ` → ${fetched.finalUrl}` : ''}`);
  if (feed.siteUrl) console.log(`Site:    ${feed.siteUrl}`);
  console.log(`Entries: ${feed.entries.length}`);

  // Newest first: what came into the feed last is what review would get next.
  const stableIds = new Map<string, string>();
  const posts = oldestFirst(
    feed.entries.map((entry) => {
      const post = entryToPost(entry, { feedUrl: checked.url, displayName: name });
      stableIds.set(post.id, entry.stableId);
      return post;
    }),
  ).reverse();

  for (const [index, post] of posts.slice(0, 3).entries()) {
    console.log('');
    console.log(`${index + 1}. ${post.createdAt?.toISOString().slice(0, 16).replace('T', ' ') ?? 'no date'}`);
    console.log(`   Stable id: ${stableIds.get(post.id)}`);
    console.log(`   Item id:   ${post.id}`);
    console.log(`   Article:   ${post.url || '(no link)'}`);
    console.log(`   Text (${post.text.length} chars):`);
    for (const line of post.text.slice(0, 600).split('\n')) console.log(`     ${line}`);
    if (post.text.length > 600) console.log('     …');
  }
}

main().catch((error) => {
  console.error('rss:check failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
