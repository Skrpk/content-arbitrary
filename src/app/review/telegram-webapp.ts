/**
 * What the review Mini Apps use of Telegram's WebApp script, and the colours
 * that make them look native in either theme.
 */

export interface TelegramWebApp {
  initData: string;
  ready: () => void;
  expand: () => void;
  close: () => void;
  themeParams?: Record<string, string>;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export const TELEGRAM_WEB_APP_SCRIPT = 'https://telegram.org/js/telegram-web-app.js';

export const theme = {
  bg: 'var(--tg-theme-bg-color, #ffffff)',
  text: 'var(--tg-theme-text-color, #111111)',
  hint: 'var(--tg-theme-hint-color, #707579)',
  link: 'var(--tg-theme-link-color, #2481cc)',
  button: 'var(--tg-theme-button-color, #2481cc)',
  buttonText: 'var(--tg-theme-button-text-color, #ffffff)',
  secondaryBg: 'var(--tg-theme-secondary-bg-color, #f1f1f1)',
};

/** The post id from the page URL, or null if there is no usable one. */
export function postIdFromLocation(): number | null {
  // Read straight from the URL: useSearchParams would force a Suspense
  // boundary around a page that has nothing to stream.
  const postId = Number(new URLSearchParams(window.location.search).get('post'));
  return Number.isSafeInteger(postId) && postId > 0 ? postId : null;
}
