import { describe, expect, it } from 'vitest';
import { sourcePlatformEnum } from '@/db/schema';
import { formatSourceLabel, platformOfPostId, sourceLabelOfPost } from '@/lib/sources/display';
import { sourceAdapter } from '@/lib/sync/source-adapters';

/**
 * Every platform has its identity and its adapter: the sync run hands each
 * source to its platform's adapter, and a stored post is named by its id.
 */
describe('source platforms', () => {
  it('has an adapter for every platform a source can be', () => {
    for (const platform of sourcePlatformEnum.enumValues) {
      expect(sourceAdapter(platform).platform).toBe(platform);
    }
  });

  it('tells a stored post’s platform by its external id, X by having no prefix', () => {
    expect(platformOfPostId('1750000000000000001')).toBe('x');
    expect(platformOfPostId('rss:ab12:cd34')).toBe('rss');
    expect(platformOfPostId('tg:spacenews/42')).toBe('telegram');
  });

  it('names a source as people know it', () => {
    expect(formatSourceLabel('x', 'NASA')).toBe('@NASA');
    expect(formatSourceLabel('telegram', '@spacenews')).toBe('@spacenews');
    expect(formatSourceLabel('rss', 'NASA Breaking News')).toBe('NASA Breaking News');
    expect(sourceLabelOfPost('rss:ab12:cd34', 'Space.com')).toBe('Space.com');
    expect(sourceLabelOfPost('1750000000000000001', null)).toBeNull();
  });
});
