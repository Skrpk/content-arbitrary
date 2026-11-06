import { describe, expect, it } from 'vitest';
import { SITE_NAME } from '@/lib/site';
import { CONTENT } from '@/marketing/content';
import { LOCALES } from '@/marketing/i18n';

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
});
