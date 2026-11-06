import { PublicPageView, publicPageMetadata } from '@/marketing/pages';

export const metadata = publicPageMetadata('en', 'rss-to-telegram');

export default function Page() {
  return <PublicPageView locale="en" page="rss-to-telegram" />;
}
