import { PublicPageView, publicPageMetadata } from '@/marketing/pages';

export const metadata = publicPageMetadata('en', 'schedule-telegram-posts');

export default function Page() {
  return <PublicPageView locale="en" page="schedule-telegram-posts" />;
}
