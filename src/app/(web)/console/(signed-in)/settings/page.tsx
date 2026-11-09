'use client';

import { SettingsPanel } from '@/components/settings-panel';
import { useWebsiteTools } from '../../use-website-tools';

/** Settings on the website: the same page as the Mini App's. */
export default function SettingsPage() {
  const { request, confirm, openLink } = useWebsiteTools();
  return <SettingsPanel request={request} confirm={confirm} openLink={openLink} />;
}
