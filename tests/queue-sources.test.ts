import { describe, expect, it } from 'vitest';
import { cardsFromSource, queueSources, sourceKey, type SourcedCard } from '@/components/queue-sources';

const post = (id: number, platform: SourcedCard['platform'], sourceLabel: string | null) => ({ id, platform, sourceLabel });
const card = (id: number, platform: SourcedCard['platform'], label: string | null, story: SourcedCard['alsoInStory'] = []): SourcedCard => ({
  ...post(id, platform, label),
  alsoInStory: story,
});

const cards = [
  card(1, 'rss', 'Universe Today', [post(2, 'telegram', '@mycosmos')]),
  card(3, 'telegram', '@mycosmos'),
  card(4, 'x', '@NASA'),
  card(5, 'telegram', '@mycosmos'),
];

describe('the queue source filter', () => {
  it('lists every source of the loaded cards, story posts included, most waiting first', () => {
    expect(queueSources(cards, () => false).map((source) => [source.label, source.waiting])).toEqual([
      ['@mycosmos', 3],
      ['@NASA', 1],
      ['Universe Today', 1],
    ]);
  });

  it('counts only undecided cards, keeping a source whose posts are all decided', () => {
    const sources = queueSources(cards, (decided) => decided.id === 4);
    expect(sources.find((source) => source.label === '@NASA')?.waiting).toBe(0);
  });

  it('tells the same name on two platforms apart', () => {
    const sources = queueSources([card(1, 'x', 'NASA'), card(2, 'youtube', 'NASA')], () => false);
    expect(sources).toHaveLength(2);
  });

  it('shows the cards with a post from the source, a story card for a post anywhere in it', () => {
    const key = sourceKey(post(0, 'telegram', '@mycosmos'));
    expect(cardsFromSource(cards, key).map((shown) => shown.id)).toEqual([1, 3, 5]);
    expect(cardsFromSource(cards, null)).toBe(cards);
  });
});
