import { PublicPageView, publicPageMetadata } from '@/marketing/pages';

export const metadata = publicPageMetadata('en', 'terms');

export default function Page() {
  return <PublicPageView locale="en" page="terms" />;
}
