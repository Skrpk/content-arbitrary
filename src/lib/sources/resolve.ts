/**
 * A source as it would be stored, found and checked but not stored yet: what
 * each platform's `resolve*Source` returns (src/lib/sources/add-*.ts), and
 * what `addSource` takes. Onboarding resolves many candidates and stores a
 * few; the commands and Settings resolve one and store it at once.
 */
export interface ResolvedSource {
  platform: 'telegram' | 'youtube' | 'rss' | 'website';
  /** What the source is known by: a username, a channel id, a feed's or sitemap's URL. */
  externalId: string;
  /** How it is shown: `sources.username`. */
  username: string;
}
