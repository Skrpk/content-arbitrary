import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { vi } from 'vitest';
import { createAnthropicRadar } from '@/lib/radar/providers/anthropic';
import { createOpenAiRadar } from '@/lib/radar/providers/openai';
import type { RadarProvider, RadarProviderName } from '@/lib/radar/providers';

/** A Radar answer as the model would give it. */
export function radarOutput(overrides: Record<string, unknown> = {}) {
  return {
    reason: 'Схоже на те, що редактор публікує.',
    topic_fit: 90,
    editorial_fit: 80,
    importance: 70,
    predicted_rejection_reason: null,
    predicted_decision: 'approve',
    score: 82,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

function anthropicMessage(
  output: unknown,
  options: { stopReason?: string; inputTokens?: number; outputTokens?: number } = {},
) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) }],
    stop_reason: options.stopReason ?? 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: options.inputTokens ?? 1200, output_tokens: options.outputTokens ?? 90 },
  };
}

/** A Messages API response carrying `output` as its JSON text. */
export function messageResponse(
  output: unknown,
  options: { stopReason?: string; inputTokens?: number; outputTokens?: number } = {},
): Response {
  return Response.json(anthropicMessage(output, options));
}

/**
 * A real Anthropic client whose HTTP layer is a stub, so the SDK's own request
 * building and response parsing are exercised.
 */
export function fakeAnthropic(respond: (body: Record<string, unknown>) => Response | Promise<Response>) {
  const requests: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    return respond(body);
  });

  const client = new Anthropic({ apiKey: 'test-key', fetch: fetchImpl as unknown as typeof fetch, maxRetries: 0 });
  return { client, provider: createAnthropicRadar({ client }), requests, fetchImpl };
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

function openAiResponse(
  output: unknown,
  options: { status?: string; refusal?: string; inputTokens?: number; outputTokens?: number } = {},
) {
  return {
    id: 'resp_test',
    object: 'response',
    model: 'gpt-6-luna',
    status: options.status ?? 'completed',
    incomplete_details: options.status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: options.refusal
          ? [{ type: 'refusal', refusal: options.refusal }]
          : [
              {
                type: 'output_text',
                text: typeof output === 'string' ? output : JSON.stringify(output),
                annotations: [],
              },
            ],
      },
    ],
    usage: {
      input_tokens: options.inputTokens ?? 1200,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: options.outputTokens ?? 90,
      output_tokens_details: { reasoning_tokens: 40 },
      total_tokens: (options.inputTokens ?? 1200) + (options.outputTokens ?? 90),
    },
  };
}

/** A Responses API response carrying `output` as its JSON text. */
export function responsesResponse(
  output: unknown,
  options: { status?: string; refusal?: string; inputTokens?: number; outputTokens?: number } = {},
): Response {
  return Response.json(openAiResponse(output, options));
}

/** A real OpenAI client whose HTTP layer is a stub. */
export function fakeOpenAi(respond: (body: Record<string, unknown>) => Response | Promise<Response>) {
  const requests: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    return respond(body);
  });

  const client = new OpenAI({ apiKey: 'test-key', fetch: fetchImpl as unknown as typeof fetch, maxRetries: 0 });
  return { client, provider: createOpenAiRadar({ client }), requests, fetchImpl };
}

// ---------------------------------------------------------------------------
// Batches, for either provider
// ---------------------------------------------------------------------------

/** What the fake batch does with one request. */
export type FakeOutcome =
  | { output: unknown; cutOff?: boolean }
  | { error: string };

export interface FakeBatchRequest {
  customId: string;
  /** The request as the provider would receive it, serialised, for inspection. */
  json: string;
}

/**
 * A provider's batch API, faked at the HTTP layer: a batch is in progress on
 * its first poll and finished on the next, and its results are whatever
 * `respond` makes of each request.
 */
export function fakeBatchProvider(
  name: RadarProviderName,
  respond: (request: FakeBatchRequest) => FakeOutcome,
): { provider: RadarProvider; submitted: FakeBatchRequest[][] } {
  return name === 'anthropic' ? fakeAnthropicBatches(respond) : fakeOpenAiBatches(respond);
}

function fakeAnthropicBatches(respond: (request: FakeBatchRequest) => FakeOutcome) {
  type Entry = { custom_id: string; params: unknown };
  const batches = new Map<string, { requests: Entry[]; polls: number }>();
  const submitted: FakeBatchRequest[][] = [];

  const batchObject = (id: string, ended: boolean, count: number) => ({
    id,
    type: 'message_batch',
    processing_status: ended ? 'ended' : 'in_progress',
    request_counts: { processing: ended ? 0 : count, succeeded: ended ? count : 0, errored: 0, canceled: 0, expired: 0 },
    created_at: '2026-10-06T10:00:00Z',
    expires_at: '2026-10-07T10:00:00Z',
    ended_at: ended ? '2026-10-06T10:05:00Z' : null,
    archived_at: null,
    cancel_initiated_at: null,
    results_url: ended ? `https://api.anthropic.com/v1/messages/batches/${id}/results` : null,
  });

  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? 'GET';

    if (method === 'POST' && url.pathname === '/v1/messages/batches') {
      const { requests } = JSON.parse(String(init?.body)) as { requests: Entry[] };
      const id = `msgbatch_${batches.size + 1}`;
      batches.set(id, { requests, polls: 0 });
      submitted.push(requests.map((entry) => ({ customId: entry.custom_id, json: JSON.stringify(entry.params) })));
      return Response.json(batchObject(id, false, requests.length));
    }

    const results = /^\/v1\/messages\/batches\/([^/]+)\/results$/.exec(url.pathname);
    if (results) {
      const body = batches
        .get(results[1]!)!
        .requests.map((entry) => {
          const outcome = respond({ customId: entry.custom_id, json: JSON.stringify(entry.params) });
          const result =
            'error' in outcome
              ? { type: 'errored', error: { type: 'error', error: { type: 'api_error', message: outcome.error } } }
              : {
                  type: 'succeeded',
                  message: anthropicMessage(outcome.output, {
                    stopReason: outcome.cutOff ? 'max_tokens' : 'end_turn',
                    inputTokens: 1000,
                    outputTokens: 80,
                  }),
                };
          return JSON.stringify({ custom_id: entry.custom_id, result });
        })
        .join('\n');
      return new Response(body, { status: 200, headers: { 'content-type': 'application/binary' } });
    }

    const retrieve = /^\/v1\/messages\/batches\/([^/]+)$/.exec(url.pathname);
    if (retrieve) {
      const batch = batches.get(retrieve[1]!)!;
      batch.polls += 1;
      return Response.json(batchObject(retrieve[1]!, batch.polls > 1, batch.requests.length));
    }

    return new Response('not found', { status: 404 });
  });

  const client = new Anthropic({ apiKey: 'test-key', fetch: fetchImpl as unknown as typeof fetch, maxRetries: 0 });
  return { provider: createAnthropicRadar({ client }), submitted };
}

function fakeOpenAiBatches(respond: (request: FakeBatchRequest) => FakeOutcome) {
  type Line = { custom_id: string; method: string; url: string; body: unknown };
  const files = new Map<string, string>();
  const batches = new Map<string, { lines: Line[]; polls: number; outputFileId?: string; errorFileId?: string }>();
  const submitted: FakeBatchRequest[][] = [];

  const batchObject = (id: string) => {
    const batch = batches.get(id)!;
    const done = batch.polls > 1;
    return {
      id,
      object: 'batch',
      endpoint: '/v1/responses',
      input_file_id: 'file-in',
      completion_window: '24h',
      status: done ? 'completed' : 'in_progress',
      created_at: 1_790_000_000,
      output_file_id: done ? batch.outputFileId : undefined,
      error_file_id: done ? batch.errorFileId : undefined,
      request_counts: { total: batch.lines.length, completed: done ? batch.lines.length : 0, failed: 0 },
    };
  };

  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? 'GET';

    if (method === 'POST' && url.pathname === '/v1/files') {
      const form = await new Request(url, init).formData();
      const file = form.get('file') as File;
      const id = `file-${files.size + 1}`;
      files.set(id, await file.text());
      return Response.json({ id, object: 'file', bytes: file.size, created_at: 0, filename: file.name, purpose: 'batch' });
    }

    if (method === 'POST' && url.pathname === '/v1/batches') {
      const { input_file_id: inputFileId } = JSON.parse(String(init?.body)) as { input_file_id: string };
      const lines = files
        .get(inputFileId)!
        .split('\n')
        .map((line) => JSON.parse(line) as Line);
      const id = `batch_${batches.size + 1}`;
      batches.set(id, { lines, polls: 0 });
      submitted.push(lines.map((line) => ({ customId: line.custom_id, json: JSON.stringify(line.body) })));

      // Results are written now, as the real API would by the time it finishes.
      const ok: string[] = [];
      const failed: string[] = [];
      for (const line of lines) {
        const outcome = respond({ customId: line.custom_id, json: JSON.stringify(line.body) });
        if ('error' in outcome) {
          failed.push(
            JSON.stringify({
              custom_id: line.custom_id,
              response: { status_code: 500, body: { error: { message: outcome.error } } },
              error: null,
            }),
          );
        } else {
          ok.push(
            JSON.stringify({
              custom_id: line.custom_id,
              response: {
                status_code: 200,
                body: openAiResponse(outcome.output, {
                  status: outcome.cutOff ? 'incomplete' : 'completed',
                  inputTokens: 1000,
                  outputTokens: 80,
                }),
              },
              error: null,
            }),
          );
        }
      }
      const batch = batches.get(id)!;
      if (ok.length > 0) {
        batch.outputFileId = `file-out-${id}`;
        files.set(batch.outputFileId, ok.join('\n'));
      }
      if (failed.length > 0) {
        batch.errorFileId = `file-err-${id}`;
        files.set(batch.errorFileId, failed.join('\n'));
      }
      return Response.json(batchObject(id));
    }

    const content = /^\/v1\/files\/([^/]+)\/content$/.exec(url.pathname);
    if (content) return new Response(files.get(content[1]!) ?? '', { status: 200 });

    const retrieve = /^\/v1\/batches\/([^/]+)$/.exec(url.pathname);
    if (retrieve) {
      batches.get(retrieve[1]!)!.polls += 1;
      return Response.json(batchObject(retrieve[1]!));
    }

    return new Response('not found', { status: 404 });
  });

  const client = new OpenAI({ apiKey: 'test-key', fetch: fetchImpl as unknown as typeof fetch, maxRetries: 0 });
  return { provider: createOpenAiRadar({ client }), submitted };
}
