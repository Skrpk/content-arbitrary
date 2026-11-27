/**
 * What a page shared by the Mini Apps and the website needs from its frame:
 * a fetch that proves who is asking — Telegram's signed `initData` in a Mini
 * App, the session cookie on the website — and the frame's own way of asking
 * yes or no and of opening a link.
 */
export interface PanelTools {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  confirm: (message: string) => Promise<boolean>;
  openLink: (url: string) => void;
}

/** A request the server refused: its own message, and its code when it gave one. */
export class RequestError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.code = code;
  }
}

/** A response's JSON, or an error carrying the server's own message. */
export async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!response.ok) throw new RequestError(body.error ?? `Request failed (${response.status})`, body.code ?? null);
  return body;
}

/** Whether a refusal is the server's `code`. */
export function isRefusal(error: unknown, code: string): boolean {
  return error instanceof RequestError && error.code === code;
}
