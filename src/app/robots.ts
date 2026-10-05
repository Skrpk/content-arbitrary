import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

/**
 * Index the public site; keep crawlers out of the API and the Mini Apps,
 * which are tools opened inside Telegram and mean nothing on their own.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/api/', '/review', '/settings'] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
