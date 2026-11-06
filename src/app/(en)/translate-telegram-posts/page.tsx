import { PublicPageView, publicPageMetadata } from '@/marketing/pages';

export const metadata = publicPageMetadata('en', 'translate-telegram-posts');

export default function Page() {
  return <PublicPageView locale="en" page="translate-telegram-posts" />;
}
