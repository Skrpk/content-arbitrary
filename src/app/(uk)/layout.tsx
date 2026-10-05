import type { ReactNode } from 'react';
import { MarketingDocument } from '@/marketing/document';
import { marketingMetadata, marketingViewport } from '@/marketing/metadata';

/**
 * Root layout for the Ukrainian public site, under /uk. Each language has its own,
 * so the server-rendered `<html lang>` is right; the content is shared.
 */

export const metadata = marketingMetadata('uk');
export const viewport = marketingViewport;

export default function Layout({ children }: { children: ReactNode }) {
  return <MarketingDocument locale="uk">{children}</MarketingDocument>;
}
