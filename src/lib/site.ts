/**
 * The public site's identity, in one place: the landing page, its metadata,
 * the sitemap and the social preview all read from here. Words that change
 * with the language live in src/marketing/content.ts.
 *
 * Nothing here is secret, and nothing reads the validated server env — the
 * marketing pages are static and must build without the bot's credentials.
 */

/** Product name as shown on the site, in every language. */
export const SITE_NAME = 'Content Radar';

/**
 * Canonical origin. A custom domain belongs here once there is one: search
 * engines index the canonical URL, so it should not stay on vercel.app.
 */
export const SITE_URL = (process.env.APP_BASE_URL ?? 'https://content-arbitrary.vercel.app').replace(
  /\/+$/,
  '',
);

/**
 * Where "get in touch" goes — a Telegram link is the natural fit for a
 * Telegram product. Set NEXT_PUBLIC_CONTACT_URL in Vercel.
 */
export const CONTACT_URL = process.env.NEXT_PUBLIC_CONTACT_URL ?? 'https://t.me/';
