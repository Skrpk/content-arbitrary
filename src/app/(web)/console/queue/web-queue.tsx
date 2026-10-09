'use client';

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { ReviewQueue } from '@/components/review-queue';

/**
 * The queue's frame on the website: requests go with the session cookie,
 * from the website's own origin, and a session that has ended sends the
 * person back to sign in rather than leaving them with errors.
 */
export function WebQueue({ initialWorkspaceId }: { initialWorkspaceId: number | null }) {
  const router = useRouter();
  const request = useCallback(
    async (path: string, init?: RequestInit) => {
      const response = await fetch(path, { ...init, credentials: 'same-origin' });
      if (response.status === 401) router.push('/login?returnTo=/queue');
      return response;
    },
    [router],
  );

  return (
    <ReviewQueue
      surface="website"
      request={request}
      initialWorkspaceId={initialWorkspaceId}
      confirm={(message) => Promise.resolve(window.confirm(message))}
      openLink={(url) => window.open(url, '_blank', 'noopener')}
    />
  );
}
