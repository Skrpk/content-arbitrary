import type { NextConfig } from 'next';
import { SITE_URL } from './src/lib/site';

/**
 * The review website is this same deployment on its own subdomain
 * (WEB_APP_URL, e.g. https://app.zmistik.com). Requests for that host are
 * routed to its pages under /console, so its paths are its own — `/queue`
 * there is the website's queue, `/queue` elsewhere the Mini App's. The API is
 * shared and stays where it is. `app.localhost` does the same in development.
 *
 * On any other host /console goes to the website, so it has one address.
 */
const webAppUrl = process.env.WEB_APP_URL?.replace(/\/+$/, '');
const webHosts = ['app.localhost', ...(webAppUrl ? [new URL(webAppUrl).hostname] : [])];
const webHost = `(${webHosts.map((host) => host.replace(/[.]/g, '\\.')).join('|')})`;

/**
 * The site's first address. Its public pages move to SITE_URL for good, so
 * search engines carry what they indexed there across; everything else on it —
 * the API, the Mini Apps — stays, for Telegram and the crons call it there.
 */
const formerSiteHost = 'content-arbitrary\\.vercel\\.app';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `postgres` (postgres.js) uses Node APIs; keep it external so Next does not
  // try to bundle it into the serverless function bundle. `jsdom` (a website's
  // article reader) loads files of its own at run time, which a bundle loses.
  serverExternalPackages: ['postgres', 'jsdom'],

  async rewrites() {
    return {
      beforeFiles: [
        { source: '/', has: [{ type: 'host', value: webHost }], destination: '/console' },
        {
          source: '/:path((?!api/|_next/|console(?:/|$)|icon\\.svg$|favicon\\.ico$).+)',
          has: [{ type: 'host', value: webHost }],
          destination: '/console/:path',
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },

  async redirects() {
    return [
      ...['/', '/uk'].map((source) => ({
        source,
        has: [{ type: 'host' as const, value: formerSiteHost }],
        destination: `${SITE_URL}${source}`,
        permanent: true,
      })),
      ...(webAppUrl
        ? [
            {
              source: '/console/:path*',
              missing: [{ type: 'host' as const, value: webHost }],
              destination: `${webAppUrl}/:path*`,
              permanent: false,
            },
          ]
        : []),
    ];
  },
};

export default nextConfig;
