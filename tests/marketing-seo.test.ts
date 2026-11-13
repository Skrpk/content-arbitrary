import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SITE_NAME } from '@/lib/site';
import { CONTENT } from '@/marketing/content';
import { LOCALES } from '@/marketing/i18n';
import { pageTitle } from '@/marketing/metadata';
import { PUBLIC_PAGES } from '@/marketing/pages';
import { PUBLIC_PAGE_KEYS, PUBLIC_SITE_PATHS } from '@/marketing/paths';
import nextConfig from '../next.config';

/** What a results page has room for: past these, Google cuts the text off. */
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 160;

describe('the public site, as a search result', () => {
  it.each(LOCALES)('fits the results page in %s, and names where it publishes', (locale) => {
    const { meta, hero } = CONTENT[locale];
    expect(`${meta.title} — ${SITE_NAME}`.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(meta.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    // What people search for is in the title; the page's own headline is about them, not a platform.
    for (const platform of ['Telegram', 'Threads']) {
      expect(meta.title).toContain(platform);
      expect(meta.description).toContain(platform);
      expect(hero.lead).toContain(platform);
    }
  });

  it.each(LOCALES)('holds the other public pages to the same limits in %s, and leaves no blank to fill in', (locale) => {
    for (const pages of Object.values(PUBLIC_PAGES)) {
      const page = pages[locale];
      expect(pageTitle(page.title).length).toBeLessThanOrEqual(TITLE_MAX);
      expect(pageTitle(page.title).match(new RegExp(SITE_NAME, 'g'))).toHaveLength(1);
      expect(page.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
      expect(renderToStaticMarkup(page.body)).not.toMatch(/\[[^\]]*\]/);
    }
  });

  it('sends every public page at the site’s first address on to the same page at its own', async () => {
    expect([...PUBLIC_PAGE_KEYS].sort()).toEqual(Object.keys(PUBLIC_PAGES).sort());
    expect(PUBLIC_SITE_PATHS).toHaveLength((PUBLIC_PAGE_KEYS.length + 1) * LOCALES.length);

    const redirects = await nextConfig.redirects!();
    for (const path of PUBLIC_SITE_PATHS) {
      expect(redirects).toContainEqual({
        source: path,
        has: [{ type: 'host', value: 'content-arbitrary\\.vercel\\.app' }],
        destination: `https://www.zmistik.com${path}`,
        permanent: true,
      });
    }
    // The Mini Apps and the API stay where Telegram and the crons call them.
    const sources = redirects.map((redirect) => redirect.source);
    for (const appPath of ['/queue', '/review', '/settings', '/source-stats', '/api/:path*']) expect(sources).not.toContain(appPath);
  });
});
