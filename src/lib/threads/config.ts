import type { Env } from '@/lib/env';

/**
 * Threads, as Meta's Threads API reaches it: the authorization window people
 * connect an account through, the Graph API the tokens are used on, and the
 * app this deployment is — its Threads app ID and secret, and the callback
 * registered for it, on the website.
 */

export const THREADS_AUTHORIZE_URL = 'https://threads.com/oauth/authorize';
export const THREADS_GRAPH_URL = 'https://graph.threads.com';
export const THREADS_API_VERSION = 'v1.0';

/**
 * What a connected account allows: reading who it is, publishing to it, and
 * reading public profiles' posts — the account that reads Threads sources.
 * Asking for more means everyone connected so far connects again.
 */
export const THREADS_SCOPES = ['threads_basic', 'threads_content_publish', 'threads_profile_discovery'] as const;

/** The permission reading a public profile's posts takes. */
export const THREADS_DISCOVERY_SCOPE = 'threads_profile_discovery';

export interface ThreadsApp {
  appId: string;
  appSecret: string;
  /** Where Meta sends people back to; registered in the app's Threads settings. */
  redirectUri: string;
}

/** The app, or null while Threads is not configured — no app, or no website to come back to. */
export function threadsApp(env: Pick<Env, 'THREADS_APP_ID' | 'THREADS_APP_SECRET' | 'WEB_APP_URL'>): ThreadsApp | null {
  if (!env.THREADS_APP_ID || !env.THREADS_APP_SECRET || !env.WEB_APP_URL) return null;
  return { appId: env.THREADS_APP_ID, appSecret: env.THREADS_APP_SECRET, redirectUri: threadsCallbackUrl(env.WEB_APP_URL) };
}

export function threadsCallbackUrl(webAppUrl: string): string {
  return `${webAppUrl}/api/threads/callback`;
}

/** The website's settings page, saying how connecting went. */
export function threadsSettingsUrl(webAppUrl: string, outcome?: ThreadsConnectOutcome): string {
  return `${webAppUrl}/settings${outcome ? `?threads=${outcome}` : ''}`;
}

export type ThreadsConnectOutcome = 'connected' | 'denied' | 'expired' | 'failed';
