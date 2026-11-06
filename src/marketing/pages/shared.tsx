import type { ReactNode } from 'react';

/** A public page beyond the landing: its words in one language. */
export interface PublicPage {
  /** The page's heading, and its title in search results. */
  title: string;
  /** Its summary in search results, short enough to show whole. */
  description: string;
  /** From when it applies, for a document that binds. */
  effective?: string;
  body: ReactNode;
}

/** Where anything about the service goes, named in the documents themselves. */
export function Contact() {
  return (
    <a href="https://t.me/scp_afrc" rel="noopener">
      @scp_afrc
    </a>
  );
}
