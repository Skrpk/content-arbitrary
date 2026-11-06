import { MarketingPage } from '@/marketing/document';
import { Landing } from '@/marketing/landing';

export default function Page() {
  return (
    <MarketingPage locale="en">
      <Landing locale="en" />
    </MarketingPage>
  );
}
