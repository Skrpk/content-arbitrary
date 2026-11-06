/**
 * The public site's identity, in one place: the landing page, its metadata,
 * the sitemap and the social preview all read from here. Words that change
 * with the language live in src/marketing/content.ts.
 *
 * Nothing here is secret, and nothing reads the validated server env — the
 * marketing pages are static and must build without the bot's credentials.
 */

/** Product name as shown on the site, in every language. */
export const SITE_NAME = 'Zmistik';

/**
 * Canonical origin of the public site: what search engines are told to index.
 * Its own value, not APP_BASE_URL — that is where the Mini Apps and the webhook
 * live, and stays on vercel.app, where Telegram has them registered.
 */
export const SITE_URL = 'https://www.zmistik.com';

/**
 * Where "get in touch" goes — a Telegram link is the natural fit for a
 * Telegram product. Set NEXT_PUBLIC_CONTACT_URL in Vercel.
 */
export const CONTACT_URL = process.env.NEXT_PUBLIC_CONTACT_URL ?? 'https://t.me/';
