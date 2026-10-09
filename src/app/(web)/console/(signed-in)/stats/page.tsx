'use client';

import { SourceStatsPanel } from '@/components/source-stats-panel';
import { useWebsiteTools } from '../../use-website-tools';

/** Source stats on the website: the same page as the Mini App's. */
export default function StatsPage() {
  const { request, confirm } = useWebsiteTools();
  return <SourceStatsPanel request={request} confirm={confirm} />;
}
