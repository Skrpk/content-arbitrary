import { describe, expect, it } from 'vitest';
import { platformOfPostId, sourceLabelOfPost } from '@/lib/sources/display';
import { ThreadsReadBudget } from '@/lib/threads/reader';
import {
  normalizeThreadsUsername,
  parseThreadsPostId,
  threadsPostToPost,
  threadsSkipReason,
} from '@/lib/threads/source';

/** A Threads account as a source: what people paste, and its posts as candidates. */

describe('a Threads account as people give it', () => {
  it('is its username, from @name, a bare name or a profile link', () => {
    for (const input of ['@NASA', 'nasa', 'https://www.threads.com/@nasa', 'threads.net/@nasa?hl=en', 'https://threads.com/nasa/']) {
      expect(normalizeThreadsUsername(input)).toEqual({ ok: true, username: 'nasa' });
    }
    expect(normalizeThreadsUsername('@space.x_fan')).toEqual({ ok: true, username: 'space.x_fan' });
  });

  it('is not a post’s link, nor anything a username cannot be', () => {
    expect(normalizeThreadsUsername('https://www.threads.com/@nasa/post/DAbc123')).toEqual({ ok: false, reason: 'post' });
    expect(normalizeThreadsUsername('')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeThreadsUsername('not a name')).toEqual({ ok: false, reason: 'invalid' });
    expect(normalizeThreadsUsername('.dot')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('a Threads post as a candidate', () => {
  const carousel = {
    id: '18028',
    media_type: 'CAROUSEL_ALBUM',
    permalink: 'https://www.threads.com/@nasa/post/DAbc',
    username: 'NASA',
    text: 'Two views of Saturn',
    timestamp: '2026-11-09T10:00:00+0000',
    children: {
      data: [
        { id: '1', media_type: 'IMAGE', media_url: 'https://scontent.cdninstagram.com/a.jpg' },
        { id: '2', media_type: 'VIDEO', media_url: 'https://scontent.cdninstagram.com/b.mp4', thumbnail_url: 'https://scontent.cdninstagram.com/b.jpg' },
        { id: '3', media_type: 'AUDIO', media_url: 'https://scontent.cdninstagram.com/c.m4a' },
      ],
    },
  };

  it('carries its text, its address, its author and its pictures and videos in order', () => {
    const post = threadsPostToPost(carousel, 'nasa');
    expect(post).toMatchObject({
      platform: 'threads',
      id: 'th:18028',
      url: 'https://www.threads.com/@nasa/post/DAbc',
      authorUsername: 'nasa',
      text: 'Two views of Saturn',
      isRepost: false,
    });
    expect(post.createdAt).toEqual(new Date('2026-11-09T10:00:00Z'));
    expect(post.media.map((item) => item.kind)).toEqual(['photo', 'video']);
    expect(post.media[1]).toMatchObject({ contentType: 'video/mp4', previewUrl: 'https://scontent.cdninstagram.com/b.jpg' });
    expect(parseThreadsPostId(post.id)).toBe('18028');
    expect(platformOfPostId(post.id)).toBe('threads');
    expect(sourceLabelOfPost(post.id, 'nasa')).toBe('@nasa');
  });

  it('keeps the link it attaches, when its text does not already hold it', () => {
    const post = threadsPostToPost({ id: '5', media_type: 'TEXT_POST', text: 'Read this', link_attachment_url: 'https://example.com/a' }, 'nasa');
    expect(post.text).toBe('Read this\n\nhttps://example.com/a');
  });

  it('is turned away as a repost, a quote when quotes are off, or text alone unless that is on', () => {
    const options = { includeTextOnly: false, includeQuotes: true };
    expect(threadsSkipReason({ id: '1', media_type: 'REPOST_FACADE' }, options)).toBe('a repost');
    expect(threadsSkipReason({ ...carousel, is_quote_post: true }, { ...options, includeQuotes: false })).toBe('a quote');
    expect(threadsSkipReason({ id: '2', media_type: 'TEXT_POST', text: 'Hello' }, options)).toBe('no media');
    expect(threadsSkipReason({ id: '2', media_type: 'TEXT_POST', text: 'Hello' }, { ...options, includeTextOnly: true })).toBeNull();
    expect(threadsSkipReason(carousel, options)).toBeNull();
  });
});

describe('a run’s share of a reading account’s requests', () => {
  it('is spent per account, and only per account', () => {
    const budget = new ThreadsReadBudget(2);
    expect([budget.take('a'), budget.take('a'), budget.take('a')]).toEqual([true, true, false]);
    expect(budget.take('b')).toBe(true);
  });
});
