'use client';

import { SettingsPanel } from '@/components/settings-panel';
import { useWebsiteTools } from '../../use-website-tools';

/** Settings on the website: the same page as the Mini App's. */
export default function SettingsPage() {
  const { request } = useWebsiteTools();
  return <SettingsPanel request={request} />;
}
