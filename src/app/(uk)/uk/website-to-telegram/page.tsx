import { PublicPageView, publicPageMetadata } from '@/marketing/pages';

export const metadata = publicPageMetadata('uk', 'website-to-telegram');

export default function Page() {
  return <PublicPageView locale="uk" page="website-to-telegram" />;
}
