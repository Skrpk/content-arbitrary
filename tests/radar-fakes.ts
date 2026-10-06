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
