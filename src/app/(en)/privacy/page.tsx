import { PublicPageView, publicPageMetadata } from '@/marketing/pages';

export const metadata = publicPageMetadata('en', 'privacy');

export default function Page() {
  return <PublicPageView locale="en" page="privacy" />;
}
