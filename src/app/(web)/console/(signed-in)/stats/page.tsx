import { redirect } from 'next/navigation';

/** The page's old address, kept for bookmarks: it is /sources now. */
export default function StatsPage() {
  redirect('/sources');
}
