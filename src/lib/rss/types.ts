/**
 * A feed reduced to what the pipeline needs — RSS 2.0 and Atom 1.0 alike —
 * so nothing past the parser carries an XML tree around.
 */

export type FeedFormat = 'rss2' | 'atom';

export interface ParsedFeed {
  format: FeedFormat;
  title: string | null;
  /** The site the feed belongs to, when it says. */
  siteUrl: string | null;
  /** Where it was read from. */
  feedUrl: string;
  /** In the feed's own order — usually newest first, but nothing relies on that. */
  entries: ParsedFeedEntry[];
}

export interface ParsedFeedEntry {
  /**
   * What identifies the entry from one fetch to the next: its Atom `<id>`, its
   * RSS `<guid>`, its link, or a hash of what it says — see entryStableKey.
   */
  stableId: string;
  /** The article it announces; null when the entry has no usable link. */
  url: string | null;
  title: string | null;
  /** RSS `<description>` / Atom `<summary>`, still as the feed wrote it (often HTML). */
  summary: string | null;
  /** RSS `<content:encoded>` / Atom `<content>`, likewise. */
  content: string | null;
  author: string | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
}
