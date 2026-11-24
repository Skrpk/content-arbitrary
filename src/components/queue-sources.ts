/**
 * The review queue's source filter: which sources the loaded cards come from,
 * and which cards to show for one of them. Kept apart from the component so
 * it can be tested without a browser.
 */

type Platform = 'x' | 'rss' | 'telegram' | 'youtube' | 'website' | 'threads';

/** What a post says of its source, as the queue sends it. */
export interface SourcedPost {
  id: number;
  platform: Platform;
  sourceLabel: string | null;
}

/** A card: its post, and the other waiting posts of its story. */
export interface SourcedCard extends SourcedPost {
  alsoInStory: SourcedPost[];
}

export interface QueueSource {
  /** Platform and label: the same name on two platforms is two sources. */
  key: string;
  platform: Platform;
  label: string;
  /** Its posts still undecided on the page, counted wherever they sit in a story. */
  waiting: number;
}

export function sourceKey(post: SourcedPost): string {
  return `${post.platform}:${post.sourceLabel ?? ''}`;
}

/**
 * Every source of the loaded cards, most posts waiting first. A source whose
 * posts have all been decided stays on the list with 0, so a filter on it does
 * not vanish from under the reviewer.
 */
export function queueSources(cards: SourcedCard[], isDecided: (card: SourcedCard) => boolean): QueueSource[] {
  const sources = new Map<string, QueueSource>();
  for (const card of cards) {
    const decided = isDecided(card);
    for (const post of [card, ...card.alsoInStory]) {
      const key = sourceKey(post);
      const source = sources.get(key) ?? { key, platform: post.platform, label: post.sourceLabel ?? 'unknown source', waiting: 0 };
      if (!decided) source.waiting += 1;
      sources.set(key, source);
    }
  }
  return [...sources.values()].sort((a, b) => b.waiting - a.waiting || a.label.localeCompare(b.label));
}

/**
 * The cards with a post from the source: a story's card shows when any of its
 * posts is, since the card is decided as one.
 */
export function cardsFromSource<Card extends SourcedCard>(cards: Card[], key: string | null): Card[] {
  if (key === null) return cards;
  return cards.filter((card) => [card, ...card.alsoInStory].some((post) => sourceKey(post) === key));
}
