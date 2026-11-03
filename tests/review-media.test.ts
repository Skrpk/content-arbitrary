import { describe, expect, it } from 'vitest';
import { shownMedia } from '@/lib/review/media';

describe('shownMedia', () => {
  it('shows a post’s own media, and not the article’s picture beside them', () => {
    expect(
      shownMedia({
        externalId: '1760000000000099001',
        reviewMedia: [{ kind: 'photo', url: 'https://pbs.twimg.com/a.jpg' }],
        sourceMetadata: { previewImageUrl: 'https://cdn.example/t.jpg' },
      }),
    ).toEqual([{ kind: 'photo', imageUrl: 'https://pbs.twimg.com/a.jpg' }]);
  });

  it('shows a post with no media the picture its feed entry or website page named, or nothing', () => {
    expect(
      shownMedia({ externalId: 'rss:x', reviewMedia: [], sourceMetadata: { previewImageUrl: 'https://cdn.example/t.jpg' } }),
    ).toEqual([{ kind: 'photo', imageUrl: 'https://cdn.example/t.jpg' }]);
    expect(
      shownMedia({
        externalId: 'web:x',
        reviewMedia: null,
        sourceMetadata: { website: { sitemapUrl: 'https://site.example/sitemap.xml', extractedLength: 900, imageUrl: 'https://site.example/og.jpg' } },
      }),
    ).toEqual([{ kind: 'photo', imageUrl: 'https://site.example/og.jpg' }]);
    expect(shownMedia({ externalId: 'rss:x', reviewMedia: [], sourceMetadata: null })).toEqual([]);
  });
});
