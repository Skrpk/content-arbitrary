'use client';

import { useRouter } from 'next/navigation';
import { PostEditor } from '@/components/rich-editor/post-editor';
import { useWebsiteTools } from '../../../use-website-tools';

/** The editor, framed for the website: done means back where it was opened from, on the post's channel and at its card. */
export function WebPostEditor({
  postId,
  workspaceId,
  from,
}: {
  postId: number;
  workspaceId: number | null;
  from: 'queue' | 'scheduled';
}) {
  const tools = useWebsiteTools();
  const router = useRouter();
  // Back to the queue at the post's own card, not at the top of the list.
  const queue = new URLSearchParams({ ...(workspaceId ? { workspace: String(workspaceId) } : {}), post: String(postId) });
  const back = from === 'scheduled' ? '/scheduled' : `/queue?${queue}`;
  return (
    <PostEditor
      postId={postId}
      {...tools}
      onDone={() => router.push(back)}
      backTo={from === 'scheduled' ? 'Scheduled' : 'the queue'}
    />
  );
}
