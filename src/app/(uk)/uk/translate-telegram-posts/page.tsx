import { PublicPageView, publicPageMetadata } from '@/marketing/pages';

export const metadata = publicPageMetadata('uk', 'translate-telegram-posts');

export default function Page() {
  return <PublicPageView locale="uk" page="translate-telegram-posts" />;
}
