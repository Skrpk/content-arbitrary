import { PublicPageView, publicPageMetadata } from '@/marketing/pages';

export const metadata = publicPageMetadata('uk', 'rss-to-telegram');

export default function Page() {
  return <PublicPageView locale="uk" page="rss-to-telegram" />;
}
