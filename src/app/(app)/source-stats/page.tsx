'use client';

import { MiniAppFrame } from '@/components/mini-app-frame';
import { SourceStatsPanel } from '@/components/source-stats-panel';

/**
 * The source stats Mini App, opened from the button under /sourcestats. The
 * page itself is the website's too (src/components/source-stats-panel.tsx).
 */
export default function SourceStatsPage() {
  return (
    <MiniAppFrame opener="the button under /sourcestats">
      {(tools) => <SourceStatsPanel request={tools.request} confirm={tools.confirm} />}
    </MiniAppFrame>
  );
}
