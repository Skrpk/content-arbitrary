import { PublicPageView, publicPageMetadata } from '@/marketing/pages';

export const metadata = publicPageMetadata('uk', 'schedule-telegram-posts');

export default function Page() {
  return <PublicPageView locale="uk" page="schedule-telegram-posts" />;
}
