import { PublicPageView, publicPageMetadata } from '@/marketing/pages';

export const metadata = publicPageMetadata('uk', 'about');

export default function Page() {
  return <PublicPageView locale="uk" page="about" />;
}
