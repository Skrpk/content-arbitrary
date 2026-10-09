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
  /** Telegram's own yes/no dialog; absent on clients older than Bot API 6.2. */
  showConfirm?: (message: string, callback: (confirmed: boolean) => void) => void;
  /** Opens a link in the browser, outside the Mini App. */
  openLink?: (url: string) => void;
  /** The back arrow in the Mini App's header; absent on clients older than Bot API 6.1. */
  BackButton?: { show: () => void; hide: () => void; onClick: (callback: () => void) => void };
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

/**
 * Where to go back to once done, for a page opened from the review queue
 * rather than from a button in the chat: the queue, on the channel it was
 * showing. Null when the page was opened from the chat.
 */
export function queueReturnUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get('from') !== 'queue') return null;
  const workspace = Number(params.get('workspace'));
  return Number.isSafeInteger(workspace) && workspace > 0 ? `/queue?workspace=${workspace}` : '/queue';
}

/** The page's link back to the queue for a post: opened from there, it returns there. */
export function fromQueue(path: string, workspaceId: number): string {
  return `${path}${path.includes('?') ? '&' : '?'}from=queue&workspace=${workspaceId}`;
}

/**
 * For a page opened from the queue, the header's back arrow returns to it.
 * Call once Telegram is ready; does nothing for a page opened from the chat.
 */
export function offerBackToQueue(app: TelegramWebApp): void {
  const back = queueReturnUrl();
  if (!back || !app.BackButton) return;
  app.BackButton.onClick(() => window.location.replace(back));
  app.BackButton.show();
}

/** Done: back to the queue when the page came from there, otherwise close the Mini App. */
export function finishMiniApp(app: TelegramWebApp): void {
  const back = queueReturnUrl();
  if (back) window.location.replace(back);
  else app.close();
}
