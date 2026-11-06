import { PublicPageView, publicPageMetadata } from '@/marketing/pages';

export const metadata = publicPageMetadata('en', 'x-to-telegram');

export default function Page() {
  return <PublicPageView locale="en" page="x-to-telegram" />;
}
