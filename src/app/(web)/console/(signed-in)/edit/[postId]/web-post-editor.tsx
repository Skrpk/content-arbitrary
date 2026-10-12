'use client';

import { useRouter } from 'next/navigation';
import { PostEditor } from '@/components/rich-editor/post-editor';
import { useWebsiteTools } from '../../../use-website-tools';

/** The editor, framed for the website: done means back to the queue, on the post's channel. */
export function WebPostEditor({ postId, workspaceId }: { postId: number; workspaceId: number | null }) {
  const tools = useWebsiteTools();
  const router = useRouter();
  return (
    <PostEditor
      postId={postId}
      {...tools}
      onDone={() => router.push(workspaceId ? `/queue?workspace=${workspaceId}` : '/queue')}
    />
  );
}
