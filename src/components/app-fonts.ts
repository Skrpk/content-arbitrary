import { Geologica, JetBrains_Mono } from 'next/font/google';

/**
 * The public site's two faces, for the tools too: headings, and the monospace
 * of scores and labels. Its own module because next/font only runs under
 * Next's compiler: the root layouts import it, and nothing a test renders does.
 */
const display = Geologica({ subsets: ['latin', 'cyrillic'], variable: '--font-display', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin', 'cyrillic'], variable: '--font-mono', display: 'swap' });

/** For `<html className>`: sets `--font-display` and `--font-mono`. */
export const appFontClass = `${display.variable} ${mono.variable}`;
