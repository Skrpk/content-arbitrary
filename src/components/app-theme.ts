/**
 * The look the tools share with the public site (src/marketing/marketing.css):
 * an editor's marker over a wire feed. Paper, ink, and one highlighter colour
 * that is only ever a fill under ink text.
 *
 * The Mini Apps keep Telegram's own colours — the person's theme, in a chat
 * they chose the look of — and take the faces, the shapes and the marker. The
 * website has no Telegram to ask, so it gets the whole palette.
 */

/** Both roots: the faces, the marker, and how headings and focus look. */
export const APP_BASE_CSS = `
:root {
  --z-mark: #d4ff3f;
  --z-mark-ink: #0e1116;
  --z-border: transparent;
  --z-display: var(--font-display), ui-sans-serif, system-ui, sans-serif;
  --z-mono: var(--font-mono), ui-monospace, 'SF Mono', Menlo, monospace;
}
h1, h2, h3 { font-family: var(--z-display); letter-spacing: -0.02em; line-height: 1.15; }
button, input, select, textarea { font-family: inherit; }
button:disabled { cursor: default; }
:focus-visible { outline: 2px solid var(--tg-theme-text-color, #0e1116); outline-offset: 2px; }
`;

/** The website only: Telegram's theme variables, set to the site's palette. */
export const WEB_PALETTE_CSS = `
:root {
  color-scheme: light dark;
  --tg-theme-bg-color: #f3f4ef;
  --tg-theme-text-color: #0e1116;
  --tg-theme-hint-color: #555b65;
  --tg-theme-link-color: #3f5c00;
  --tg-theme-button-color: #0e1116;
  --tg-theme-button-text-color: #f3f4ef;
  --tg-theme-secondary-bg-color: #e8e9e2;
  --z-border: #d9dbd3;
}
@media (prefers-color-scheme: dark) {
  :root {
    --tg-theme-bg-color: #0e1116;
    --tg-theme-text-color: #f3f4ef;
    --tg-theme-hint-color: #a3a9b3;
    --tg-theme-link-color: #d4ff3f;
    --tg-theme-button-color: #d4ff3f;
    --tg-theme-button-text-color: #0e1116;
    --tg-theme-secondary-bg-color: #1b2029;
    --z-border: #2c323c;
  }
}
body { background: var(--tg-theme-bg-color); color: var(--tg-theme-text-color); }
`;
