import Anthropic from '@anthropic-ai/sdk';
import { vi } from 'vitest';

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

/** A Messages API response carrying `output` as its JSON text. */
export function messageResponse(
  output: unknown,
  options: { stopReason?: string; inputTokens?: number; outputTokens?: number } = {},
): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) }],
      stop_reason: options.stopReason ?? 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: options.inputTokens ?? 1200, output_tokens: options.outputTokens ?? 90 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
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

  const client = new Anthropic({
    apiKey: 'test-key',
    fetch: fetchImpl as unknown as typeof fetch,
    maxRetries: 0,
  });

  return { client, requests, fetchImpl };
}

type BatchRequest = { custom_id: string; params: Record<string, unknown> };

/**
 * The Message Batches API, faked at the HTTP layer: a batch is in progress on
 * its first retrieve and ended on the next, and its results are whatever
 * `respond` makes of each request.
 */
export function fakeBatchAnthropic(respond: (request: BatchRequest) => Record<string, unknown>) {
  const batches = new Map<string, { requests: BatchRequest[]; polls: number }>();
  const submitted: BatchRequest[][] = [];

  const batchObject = (id: string, ended: boolean, count: number) => ({
    id,
    type: 'message_batch',
    processing_status: ended ? 'ended' : 'in_progress',
    request_counts: {
      processing: ended ? 0 : count,
      succeeded: ended ? count : 0,
      errored: 0,
      canceled: 0,
      expired: 0,
    },
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
      const { requests } = JSON.parse(String(init?.body)) as { requests: BatchRequest[] };
      const id = `msgbatch_${batches.size + 1}`;
      batches.set(id, { requests, polls: 0 });
      submitted.push(requests);
      return Response.json(batchObject(id, false, requests.length));
    }

    const results = /^\/v1\/messages\/batches\/([^/]+)\/results$/.exec(url.pathname);
    if (results) {
      const batch = batches.get(results[1]!)!;
      const body = batch.requests
        .map((request) => JSON.stringify({ custom_id: request.custom_id, result: respond(request) }))
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

  const client = new Anthropic({
    apiKey: 'test-key',
    fetch: fetchImpl as unknown as typeof fetch,
    maxRetries: 0,
  });

  return { client, submitted, fetchImpl };
}

/** A succeeded batch result carrying `output`. */
export function succeeded(output: unknown, options: { stopReason?: string } = {}) {
  return {
    type: 'succeeded',
    message: {
      id: 'msg_batch',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: JSON.stringify(output) }],
      stop_reason: options.stopReason ?? 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1000, output_tokens: 80 },
    },
  };
}
