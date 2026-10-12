'use client';

import { useRouter } from 'next/navigation';
import { ReviewQueue } from '@/components/review-queue';
import { useWebsiteTools } from '../../use-website-tools';

/** The queue, framed for the website. */
export function WebQueue({ initialWorkspaceId }: { initialWorkspaceId: number | null }) {
  const tools = useWebsiteTools();
  const router = useRouter();
  return (
    <ReviewQueue
      surface="website"
      initialWorkspaceId={initialWorkspaceId}
      {...tools}
      onEdit={(postId, workspaceId) => router.push(`/edit/${postId}?workspace=${workspaceId}`)}
    />
  );
}
