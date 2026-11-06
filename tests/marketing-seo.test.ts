import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SITE_NAME } from '@/lib/site';
import { CONTENT } from '@/marketing/content';
import { LOCALES } from '@/marketing/i18n';
import { pageTitle } from '@/marketing/metadata';
import { PUBLIC_PAGES } from '@/marketing/pages';

/** What a results page has room for: past these, Google cuts the text off. */
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 160;

describe('the public site, as a search result', () => {
  it.each(LOCALES)('fits the results page in %s, and names the channel type it is for', (locale) => {
    const { meta, hero } = CONTENT[locale];
    expect(`${meta.title} — ${SITE_NAME}`.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(meta.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(meta.title).toContain('Telegram');
    expect(hero.title).toContain('Telegram');
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
});
