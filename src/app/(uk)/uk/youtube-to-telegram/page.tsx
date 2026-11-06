import { PublicPageView, publicPageMetadata } from '@/marketing/pages';

export const metadata = publicPageMetadata('uk', 'youtube-to-telegram');

export default function Page() {
  return <PublicPageView locale="uk" page="youtube-to-telegram" />;
}
