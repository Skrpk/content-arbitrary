import { PublicPageView, publicPageMetadata } from '@/marketing/pages';

export const metadata = publicPageMetadata('en', 'youtube-to-telegram');

export default function Page() {
  return <PublicPageView locale="en" page="youtube-to-telegram" />;
}
