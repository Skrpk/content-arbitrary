'use client';

import { MiniAppFrame } from '@/components/mini-app-frame';
import { SettingsPanel } from '@/components/settings-panel';

/**
 * The settings Mini App, opened from the Settings button under /sourcestats or
 * /addsource. The page itself is the website's too (src/components/settings-panel.tsx).
 */
export default function SettingsPage() {
  return <MiniAppFrame opener="the Settings button">{(tools) => <SettingsPanel request={tools.request} />}</MiniAppFrame>;
}
