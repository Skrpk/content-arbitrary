import type { ReactNode } from 'react';
import { MarketingDocument } from '@/marketing/document';
import { marketingMetadata, marketingViewport } from '@/marketing/metadata';

/**
 * Root layout for the English public site, at the root. Each language has its own,
 * so the server-rendered `<html lang>` is right; the content is shared.
 */

export const metadata = marketingMetadata('en');
export const viewport = marketingViewport;

export default function Layout({ children }: { children: ReactNode }) {
  return <MarketingDocument locale="en">{children}</MarketingDocument>;
}
