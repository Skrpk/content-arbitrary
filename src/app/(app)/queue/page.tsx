'use client';

import { useState } from 'react';
import { MiniAppFrame } from '@/components/mini-app-frame';
import { ReviewQueue } from '@/components/review-queue';

/**
 * The review queue Mini App, opened from the notification that new posts are
 * waiting, or from /review. The queue itself is the website's too
 * (src/components/review-queue.tsx).
 */
export default function QueuePage() {
  // The notification's buttons name the channel it was for, and a story's post.
  const [{ workspaceId, postId }] = useState(() => {
    if (typeof window === 'undefined') return { workspaceId: null, postId: null };
    const query = new URLSearchParams(window.location.search);
    const id = (name: string) => {
      const wanted = Number(query.get(name));
      return Number.isSafeInteger(wanted) && wanted > 0 ? wanted : null;
    };
    return { workspaceId: id('workspace'), postId: id('post') };
  });

  return (
    <MiniAppFrame opener="the review button">
      {(tools) => (
        <>
          <h1 style={{ fontSize: '1.05rem', fontWeight: 600, margin: '0 0 0.25rem' }}>Review queue</h1>
          <ReviewQueue surface="mini-app" initialWorkspaceId={workspaceId} initialPostId={postId} {...tools} />
        </>
      )}
    </MiniAppFrame>
  );
}
