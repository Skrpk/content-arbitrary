'use client';

import { SourceStatsPanel } from '@/components/source-stats-panel';
import { useWebsiteTools } from '../../use-website-tools';

/** Sources on the website — adding them, and their stats: the same page as the Mini App's. */
export default function SourcesPage() {
  const { request, confirm } = useWebsiteTools();
  return <SourceStatsPanel request={request} confirm={confirm} />;
}
