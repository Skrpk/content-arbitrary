import { PublicPageView, publicPageMetadata } from '@/marketing/pages';

export const metadata = publicPageMetadata('en', 'website-to-telegram');

export default function Page() {
  return <PublicPageView locale="en" page="website-to-telegram" />;
}
