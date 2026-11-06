import { PublicPageView, publicPageMetadata } from '@/marketing/pages';

export const metadata = publicPageMetadata('uk', 'terms');

export default function Page() {
  return <PublicPageView locale="uk" page="terms" />;
}
