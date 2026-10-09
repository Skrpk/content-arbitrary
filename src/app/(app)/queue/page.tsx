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
  // The notification's button names the channel it was for.
  const [workspaceId] = useState(() => {
    if (typeof window === 'undefined') return null;
    const wanted = Number(new URLSearchParams(window.location.search).get('workspace'));
    return Number.isSafeInteger(wanted) && wanted > 0 ? wanted : null;
  });

  return (
    <MiniAppFrame opener="the review button">
      {(tools) => (
        <>
          <h1 style={{ fontSize: '1.05rem', fontWeight: 600, margin: '0 0 0.25rem' }}>Review queue</h1>
          <ReviewQueue surface="mini-app" initialWorkspaceId={workspaceId} {...tools} />
        </>
      )}
    </MiniAppFrame>
  );
}
