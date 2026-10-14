'use client';

import { useRouter } from 'next/navigation';
import { PostEditor } from '@/components/rich-editor/post-editor';
import { useWebsiteTools } from '../../../use-website-tools';

/** The editor, framed for the website: done means back where it was opened from, on the post's channel. */
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
  const back = from === 'scheduled' ? '/scheduled' : workspaceId ? `/queue?workspace=${workspaceId}` : '/queue';
  return (
    <PostEditor
      postId={postId}
      {...tools}
      onDone={() => router.push(back)}
      backTo={from === 'scheduled' ? 'Scheduled' : 'the queue'}
    />
  );
}
