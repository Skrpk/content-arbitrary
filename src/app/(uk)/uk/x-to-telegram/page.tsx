import { PublicPageView, publicPageMetadata } from '@/marketing/pages';

export const metadata = publicPageMetadata('uk', 'x-to-telegram');

export default function Page() {
  return <PublicPageView locale="uk" page="x-to-telegram" />;
}
