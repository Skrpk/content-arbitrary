import { describe, expect, it } from 'vitest';
import { articleImageUrl, sniffPhotoType } from '@/lib/uploads/article-image';

describe('an article picture', () => {
  it('is a photo Telegram takes by its bytes, whatever the server called it', () => {
    expect(sniffPhotoType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffPhotoType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe('image/png');
    expect(sniffPhotoType(new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp');
    expect(sniffPhotoType(new TextEncoder().encode('GIF89a'))).toBeNull();
    expect(sniffPhotoType(new TextEncoder().encode('<html>'))).toBeNull();
    expect(sniffPhotoType(new Uint8Array())).toBeNull();
  });

  it('is the feed entry’s picture, else the website page’s og:image', () => {
    expect(articleImageUrl({ sourceMetadata: { previewImageUrl: 'https://a.example/1.jpg' } })).toBe('https://a.example/1.jpg');
    expect(
      articleImageUrl({ sourceMetadata: { website: { sitemapUrl: 'https://b.example/s.xml', extractedLength: 1, imageUrl: 'https://b.example/2.jpg' } } }),
    ).toBe('https://b.example/2.jpg');
    expect(articleImageUrl({ sourceMetadata: null })).toBeNull();
  });
});
