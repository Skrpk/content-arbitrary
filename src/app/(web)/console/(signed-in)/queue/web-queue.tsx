'use client';

import { ReviewQueue } from '@/components/review-queue';
import { useWebsiteTools } from '../../use-website-tools';

/** The queue, framed for the website. */
export function WebQueue({ initialWorkspaceId }: { initialWorkspaceId: number | null }) {
  const tools = useWebsiteTools();
  return <ReviewQueue surface="website" initialWorkspaceId={initialWorkspaceId} {...tools} />;
}
