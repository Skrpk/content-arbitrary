import type { RichDocument } from '@/lib/rich/document';

/**
 * What the post editor's assistant sends back while it answers, one JSON
 * object per line — shared by the API route and the editor's panel.
 */
export type AssistantStreamEvent =
  /** A piece of the reply, as it is written. */
  | { type: 'text'; delta: string }
  /** It is searching the web; the queries once known. */
  | { type: 'search'; queries: string[] }
  /** It has started rewriting the post. */
  | { type: 'editing' }
  /** The post as rewritten, already checked as a document — for the editor to show, not saved. */
  | { type: 'edit'; doc: RichDocument; summary: string }
  /** The pages its answer cites. */
  | { type: 'sources'; sources: AssistantSource[] }
  | { type: 'done'; remaining: number }
  | { type: 'error'; message: string };

export interface AssistantSource {
  url: string;
  title: string | null;
}

/** One earlier message of the conversation, as the editor keeps it. */
export interface AssistantHistoryMessage {
  role: 'user' | 'assistant';
  text: string;
}
