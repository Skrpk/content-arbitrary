'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import type { PanelTools } from '@/components/panel-tools';

/**
 * What the shared pages need, the website's way: requests go with the session
 * cookie from the website's own origin, and a session that has ended sends
 * the person to sign in — and back here afterwards — rather than leaving them
 * with errors.
 */
export function useWebsiteTools(): PanelTools {
  const router = useRouter();
  const pathname = usePathname();

  const request = useCallback(
    async (path: string, init?: RequestInit) => {
      const response = await fetch(path, { ...init, credentials: 'same-origin' });
      if (response.status === 401) router.push(`/login?returnTo=${encodeURIComponent(pathname)}`);
      return response;
    },
    [pathname, router],
  );

  return useMemo(
    () => ({
      request,
      confirm: (message: string) => Promise.resolve(window.confirm(message)),
      openLink: (url: string) => {
        window.open(url, '_blank', 'noopener');
      },
    }),
    [request],
  );
}
