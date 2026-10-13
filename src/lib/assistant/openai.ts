import OpenAI from 'openai';
import { z } from 'zod';
import type { AssistantHistoryMessage, AssistantSource, AssistantStreamEvent } from '@/lib/assistant/events';

/**
 * The post editor's assistant on OpenAI's Responses API: one streamed turn,
 * with web search and one function, edit_post, which hands back the whole
 * post as it should now read. The route checks that post before the editor
 * ever sees it; nothing here touches the post.
 *
 * Kept cheap: the model reasons little, web search keeps little context, the
 * output is bounded, and nothing is stored on OpenAI's side.
 */

/** Rewriting a post on request needs little deliberation; reasoning is billed as output. */
const REASONING_EFFORT = 'low' as const;
/** Room for the reasoning and a long post, which count together. */
const MAX_OUTPUT_TOKENS = 8000;

const editSchema = z.object({ html: z.string().min(1), summary: z.string() });
export type AssistantEdit = z.infer<typeof editSchema>;

const TOOLS: OpenAI.Responses.Tool[] = [
  { type: 'web_search', search_context_size: 'low' },
  {
    type: 'function',
    name: 'edit_post',
    description:
      'Replace the post with a new version. Pass the whole post as it should now read, in the post HTML, ' +
      'not only the changed part.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'The whole post as it should now read, in the post HTML.' },
        summary: {
          type: 'string',
          description: 'One short sentence on what you changed, in the language the editor writes in.',
        },
      },
      required: ['html', 'summary'],
      additionalProperties: false,
    },
  },
];

export interface AssistantTurnInput {
  instructions: string;
  /** The post's source and pictures. */
  context: string;
  history: AssistantHistoryMessage[];
  /** The editor's message, with the post as it reads now. */
  message: string;
  /** Said after the message — why the last edit could not be used. */
  followUp?: string;
}

export interface AssistantTurnResult {
  text: string;
  edit: AssistantEdit | null;
  /** Why the edit it made could not be read, if it could not. */
  editError: string | null;
  sources: AssistantSource[];
  webSearches: number;
  usage: { inputTokens: number; outputTokens: number };
}

export interface AssistantModel {
  readonly model: string;
  runTurn(
    input: AssistantTurnInput,
    emit: (event: AssistantStreamEvent) => void,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<AssistantTurnResult>;
}

export function createOpenAiAssistant(options: { apiKey?: string; client?: OpenAI; model: string }): AssistantModel {
  const client = options.client ?? new OpenAI({ apiKey: options.apiKey });
  const model = options.model;

  return {
    model,
    async runTurn(input, emit, { timeoutMs, signal }) {
      const stream = await client.responses.create(
        {
          model,
          instructions: input.instructions,
          input: [
            { role: 'developer', content: input.context },
            ...input.history.map((message) => ({ role: message.role, content: message.text })),
            { role: 'user' as const, content: input.message },
            ...(input.followUp ? [{ role: 'user' as const, content: input.followUp }] : []),
          ],
          tools: TOOLS,
          tool_choice: 'auto',
          parallel_tool_calls: false,
          reasoning: { effort: REASONING_EFFORT },
          max_output_tokens: MAX_OUTPUT_TOKENS,
          // Nothing to come back to: do not keep the post on OpenAI's side.
          store: false,
          stream: true,
        },
        { timeout: timeoutMs, signal, maxRetries: 1 },
      );

      let text = '';
      let editing = false;
      let edit: AssistantEdit | null = null;
      let editError: string | null = null;
      let webSearches = 0;
      let incomplete: string | null = null;
      const sources = new Map<string, AssistantSource>();
      const usage = { inputTokens: 0, outputTokens: 0 };

      for await (const event of stream) {
        switch (event.type) {
          case 'response.output_text.delta':
            text += event.delta;
            emit({ type: 'text', delta: event.delta });
            break;
          case 'response.web_search_call.searching':
            emit({ type: 'search', queries: [] });
            break;
          case 'response.function_call_arguments.delta':
            if (!editing) {
              editing = true;
              emit({ type: 'editing' });
            }
            break;
          case 'response.output_item.done': {
            const item = event.item;
            if (item.type === 'web_search_call' && item.action.type === 'search') {
              webSearches += 1;
              const queries = item.action.queries ?? (item.action.query ? [item.action.query] : []);
              if (queries.length > 0) emit({ type: 'search', queries });
            } else if (item.type === 'message') {
              for (const part of item.content) {
                if (part.type !== 'output_text') continue;
                for (const annotation of part.annotations) {
                  if (annotation.type === 'url_citation' && !sources.has(annotation.url)) {
                    sources.set(annotation.url, { url: annotation.url, title: annotation.title || null });
                  }
                }
              }
            } else if (item.type === 'function_call' && item.name === 'edit_post') {
              const parsed = parseEdit(item.arguments);
              if (parsed.ok) edit = parsed.edit;
              else editError = parsed.error;
            }
            break;
          }
          case 'response.completed':
          case 'response.incomplete':
            usage.inputTokens = event.response.usage?.input_tokens ?? 0;
            usage.outputTokens = event.response.usage?.output_tokens ?? 0;
            if (event.type === 'response.incomplete') incomplete = event.response.incomplete_details?.reason ?? 'incomplete';
            break;
          case 'response.failed':
            throw new Error(event.response.error?.message ?? 'The model could not answer.');
          case 'error':
            throw new Error(event.message);
        }
      }

      // An edit cut off at the output limit can still parse; it is not the whole post.
      if (incomplete && (edit || editing)) {
        edit = null;
        editError = `the answer was cut off (${incomplete}) before the post was complete.`;
      }
      if (sources.size > 0) emit({ type: 'sources', sources: [...sources.values()] });
      return { text, edit, editError, sources: [...sources.values()], webSearches, usage };
    },
  };
}

function parseEdit(args: string): { ok: true; edit: AssistantEdit } | { ok: false; error: string } {
  try {
    const parsed = editSchema.safeParse(JSON.parse(args));
    return parsed.success ? { ok: true, edit: parsed.data } : { ok: false, error: 'the edit was missing the post.' };
  } catch {
    return { ok: false, error: 'the edit was not valid JSON.' };
  }
}
