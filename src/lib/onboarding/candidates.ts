/**
 * A possible source for an onboarded channel, before it is checked (§15–§19):
 * found in the channel's own history — what it links to, what it forwards —
 * or suggested by a web search. Nothing here is trusted until it resolves
 * (src/lib/onboarding/discover-sources.ts).
 */

export type CandidateOrigin = 'history_link' | 'history_forward' | 'discovery' | 'manual';
export type CandidatePlatform = 'telegram' | 'youtube' | 'website';
/** What kind of source, as the search judged it: §19's order, primary first. */
export type CandidateKind = 'official' | 'specialist' | 'curator' | 'creator' | 'aggregator';

export interface Candidate {
  /** Who it is, to merge the same source found twice: `telegram:<name>`, `youtube:<id or @handle>`, `site:<domain>`. */
  key: string;
  platform: CandidatePlatform;
  /** What to resolve: a channel's username, a YouTube channel's link or handle, a site's home page. */
  target: string;
  /** A name to show before it resolves. */
  name: string | null;
  origin: CandidateOrigin;
  /** Posts of the channel that link to it, and that forward it. */
  links: number;
  forwards: number;
  /** The search's reason and judgement, for one it suggested. */
  reason: string | null;
  kind: CandidateKind | null;
  /** Who is behind it — a domain or a company — so two outlets of one organisation are not both picked. */
  organization: string | null;
}

/** Hosts whose second-level label is not the site's name: `pravda.com.ua` is a site, `com.ua` is not. */
const SECOND_LEVEL = new Set([
  'com.ua', 'org.ua', 'net.ua', 'gov.ua', 'edu.ua', 'in.ua', 'kiev.ua', 'kyiv.ua', 'lviv.ua', 'od.ua',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'co.kr', 'com.br', 'com.cn',
  'com.pl', 'com.tr', 'co.in', 'co.il', 'com.mx', 'com.ar', 'co.za', 'co.nz',
]);

/** The site a host belongs to: `news.example.com.ua` → `example.com.ua`. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return SECOND_LEVEL.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/**
 * Sites that are never a source: payments and donations, shops and
 * affiliates, link shorteners (not followed), app stores, forms and documents,
 * and social networks, which have no feed to follow.
 */
const BLOCKED_DOMAINS = new Set([
  'monobank.ua', 'patreon.com', 'buymeacoffee.com', 'donatello.to', 'privat24.ua', 'privatbank.ua', 'paypal.com', 'ko-fi.com', 'boosty.to',
  'aliexpress.com', 'aliexpress.ru', 'rozetka.com.ua', 'amazon.com', 'amzn.to', 'prom.ua', 'olx.ua', 'ebay.com',
  'bit.ly', 't.ly', 'goo.gl', 'tinyurl.com', 'cutt.ly', 'is.gd', 'ow.ly', 'clck.ru',
  'apple.com', 'google.com', 'forms.gle', 'gle.com', 'microsoft.com',
  'facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'threads.net', 'threads.com', 'tiktok.com', 'linkedin.com', 'x.com', 'twitter.com', 't.co',
  'vk.com', 'discord.gg', 'discord.com', 'reddit.com', 'pinterest.com', 'wikipedia.org', 'whatsapp.com', 'viber.com',
]);

export function isBlockedDomain(domain: string): boolean {
  return BLOCKED_DOMAINS.has(domain);
}
