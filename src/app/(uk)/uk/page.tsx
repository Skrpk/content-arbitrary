import { MarketingPage } from '@/marketing/document';
import { Landing } from '@/marketing/landing';

export default function Page() {
  return (
    <MarketingPage locale="uk">
      <Landing locale="uk" />
    </MarketingPage>
  );
}
