import type { NextConfig } from 'next';

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

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `postgres` (postgres.js) uses Node APIs; keep it external so Next does not
  // try to bundle it into the serverless function bundle.
  serverExternalPackages: ['postgres'],

  async rewrites() {
    return {
      beforeFiles: [
        { source: '/', has: [{ type: 'host', value: webHost }], destination: '/console' },
        {
          source: '/:path((?!api/|_next/|console(?:/|$)|icon\\.svg$).+)',
          has: [{ type: 'host', value: webHost }],
          destination: '/console/:path',
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },

  async redirects() {
    return webAppUrl
      ? [
          {
            source: '/console/:path*',
            missing: [{ type: 'host', value: webHost }],
            destination: `${webAppUrl}/:path*`,
            permanent: false,
          },
        ]
      : [];
  },
};

export default nextConfig;
