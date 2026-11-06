import { PublicPageView, publicPageMetadata } from '@/marketing/pages';

export const metadata = publicPageMetadata('uk', 'privacy');

export default function Page() {
  return <PublicPageView locale="uk" page="privacy" />;
}
