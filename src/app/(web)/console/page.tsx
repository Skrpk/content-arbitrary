import { redirect } from 'next/navigation';
import { currentWebViewer } from '@/lib/accounts/current';

/**
 * The website's front door: the queue for someone signed in, the sign-in page
 * for anyone else. Paths here are the website's own (`/queue`, `/login`); on
 * its subdomain they reach these pages under /console — see next.config.ts.
 */
export default async function ConsoleHome() {
  redirect((await currentWebViewer()) ? '/queue' : '/login');
}
