import { PublicPageView, publicPageMetadata } from '@/marketing/pages';

export const metadata = publicPageMetadata('en', 'about');

export default function Page() {
  return <PublicPageView locale="en" page="about" />;
}
