import { describe, expect, it } from 'vitest';
import { RadarError, scorePost } from '@/lib/radar/score';
import { fakeAnthropic, messageResponse, radarOutput } from './radar-fakes';

const input = {
  profile: 'Space channel.',
  approvalRate: 0.25,
  item: { sourceUsername: 'esa', text: 'New telescope image', media: 'photo' },
  examples: [],
};

describe('scorePost', () => {
  it('asks Haiku for the structured prediction and returns it with usage', async () => {
    const { client, requests } = fakeAnthropic(() => messageResponse(radarOutput(), { inputTokens: 1500, outputTokens: 70 }));

    const prediction = await scorePost(client, input, { timeoutMs: 5000 });

    expect(prediction).toEqual({
      score: 82,
      predictedDecision: 'approve',
      topicFit: 90,
      editorialFit: 80,
      importance: 70,
      reason: 'Схоже на те, що редактор публікує.',
      predictedRejectionReason: null,
      inputTokens: 1500,
      outputTokens: 70,
    });

    const request = requests[0]!;
    expect(request.model).toBe('claude-haiku-4-5');
    expect(String(request.system)).toContain('Space channel.');
    expect((request.output_config as { format: { type: string } }).format.type).toBe('json_schema');
  });

  it('clamps scores the API cannot range-check, and drops a reject reason on an approve', async () => {
    const { client } = fakeAnthropic(() =>
      messageResponse(radarOutput({ score: 140, topic_fit: -5, predicted_rejection_reason: 'too_minor' })),
    );

    const prediction = await scorePost(client, input, { timeoutMs: 5000 });
    expect(prediction.score).toBe(100);
    expect(prediction.topicFit).toBe(0);
    expect(prediction.predictedRejectionReason).toBeNull();
  });

  it('keeps the predicted reason on a reject', async () => {
    const { client } = fakeAnthropic(() =>
      messageResponse(radarOutput({ predicted_decision: 'reject', score: 20, predicted_rejection_reason: 'wrong_topic' })),
    );
    expect((await scorePost(client, input, { timeoutMs: 5000 })).predictedRejectionReason).toBe('wrong_topic');
  });

  it('treats a refusal as a failure, keeping the tokens it cost', async () => {
    const { client } = fakeAnthropic(() =>
      messageResponse('', { stopReason: 'refusal', inputTokens: 900, outputTokens: 0 }),
    );

    const failure = await scorePost(client, input, { timeoutMs: 5000 }).catch((error) => error);
    expect(failure).toBeInstanceOf(RadarError);
    expect(failure.usage).toEqual({ inputTokens: 900, outputTokens: 0 });
  });

  it('fails on an answer that does not match the schema', async () => {
    const { client } = fakeAnthropic(() => messageResponse({ score: 'high' }, { inputTokens: 800 }));

    const failure = await scorePost(client, input, { timeoutMs: 5000 }).catch((error) => error);
    expect(failure).toBeInstanceOf(RadarError);
    expect(failure.message).toMatch(/did not match the schema/);
    expect(failure.usage.inputTokens).toBe(800);
  });
});
