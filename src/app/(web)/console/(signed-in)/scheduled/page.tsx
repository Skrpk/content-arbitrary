'use client';

import { useRouter } from 'next/navigation';
import { ScheduledPosts } from '@/components/scheduled-posts';
import { useWebsiteTools } from '../../use-website-tools';

/** Scheduled posts on the website: edited in the full editor, which comes back here. */
export default function ScheduledPage() {
  const tools = useWebsiteTools();
  const router = useRouter();
  return (
    <ScheduledPosts
      {...tools}
      onEdit={(postId, workspaceId) => router.push(`/edit/${postId}?workspace=${workspaceId}&from=scheduled`)}
    />
  );
}
