import { describe, expect, it } from 'vitest';
import { RadarError } from '@/lib/radar/output';
import type { RadarInput } from '@/lib/radar/output';
import { createRadarProvider, providerOfBatch } from '@/lib/radar/providers';
import { fakeAnthropic, fakeOpenAi, messageResponse, radarOutput, responsesResponse } from './radar-fakes';

const input: RadarInput = {
  profile: 'Space channel.',
  approvalRate: 0.25,
  item: { sourceUsername: 'esa', text: 'New telescope image', media: 'photo' },
  examples: [],
};

const withImage: RadarInput = {
  ...input,
  image: { kind: 'base64', mediaType: 'image/jpeg', data: 'AAAA' },
};

const expected = {
  score: 82,
  predictedDecision: 'approve',
  topicFit: 90,
  editorialFit: 80,
  importance: 70,
  reason: 'Схоже на те, що редактор публікує.',
  predictedRejectionReason: null,
};

describe('OpenAI provider (GPT-6 Luna)', () => {
  it('asks Luna through the Responses API, with low reasoning and nothing stored', async () => {
    const { provider, requests } = fakeOpenAi(() =>
      responsesResponse(radarOutput(), { inputTokens: 1500, outputTokens: 70 }),
    );

    const prediction = await provider.score(input, { timeoutMs: 5000 });

    expect(prediction).toEqual({ ...expected, inputTokens: 1500, outputTokens: 70 });
    expect(provider).toMatchObject({ name: 'openai', model: 'gpt-6-luna' });

    const request = requests[0]!;
    expect(request.model).toBe('gpt-6-luna');
    expect(String(request.instructions)).toContain('Space channel.');
    expect(request.reasoning).toEqual({ effort: 'low' });
    expect(request.store).toBe(false);
    expect(request.text).toMatchObject({ format: { type: 'json_schema', name: 'radar_prediction', strict: true } });
  });

  it('sends an image inline, at low detail', async () => {
    const { provider, requests } = fakeOpenAi(() => responsesResponse(radarOutput()));
    await provider.score(withImage, { timeoutMs: 5000 });

    expect(JSON.stringify(requests[0]!.input)).toContain(
      '{"type":"input_image","image_url":"data:image/jpeg;base64,AAAA","detail":"low"}',
    );
  });

  it('treats a cut-off answer as a failure, keeping the tokens it cost', async () => {
    const { provider } = fakeOpenAi(() =>
      responsesResponse(radarOutput(), { status: 'incomplete', inputTokens: 900, outputTokens: 4000 }),
    );

    const failure = await provider.score(input, { timeoutMs: 5000 }).catch((error) => error);
    expect(failure).toBeInstanceOf(RadarError);
    expect(failure.message).toContain('incomplete, max_output_tokens');
    expect(failure.usage).toEqual({ inputTokens: 900, outputTokens: 4000 });
  });

  it('treats a refusal as a failure', async () => {
    const { provider } = fakeOpenAi(() => responsesResponse(null, { refusal: 'Cannot help.' }));
    await expect(provider.score(input, { timeoutMs: 5000 })).rejects.toThrow(/refused: Cannot help/);
  });

  it('fails on an answer that does not match the schema', async () => {
    const { provider } = fakeOpenAi(() => responsesResponse({ score: 'high' }));
    await expect(provider.score(input, { timeoutMs: 5000 })).rejects.toThrow(/did not match the schema/);
  });
});

describe('Anthropic provider (Claude Haiku 4.5)', () => {
  it('asks Haiku for the structured prediction and returns it with usage', async () => {
    const { provider, requests } = fakeAnthropic(() =>
      messageResponse(radarOutput(), { inputTokens: 1500, outputTokens: 70 }),
    );

    expect(await provider.score(input, { timeoutMs: 5000 })).toEqual({
      ...expected,
      inputTokens: 1500,
      outputTokens: 70,
    });
    expect(provider).toMatchObject({ name: 'anthropic', model: 'claude-haiku-4-5' });

    const request = requests[0]!;
    expect(request.model).toBe('claude-haiku-4-5');
    expect(String(request.system)).toContain('Space channel.');
    expect((request.output_config as { format: { type: string } }).format.type).toBe('json_schema');
  });

  it('sends an image as a base64 block', async () => {
    const { provider, requests } = fakeAnthropic(() => messageResponse(radarOutput()));
    await provider.score(withImage, { timeoutMs: 5000 });

    expect(JSON.stringify(requests[0]!.messages)).toContain(
      '{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"AAAA"}}',
    );
  });

  it('treats a refusal as a failure, keeping the tokens it cost', async () => {
    const { provider } = fakeAnthropic(() =>
      messageResponse('', { stopReason: 'refusal', inputTokens: 900, outputTokens: 0 }),
    );

    const failure = await provider.score(input, { timeoutMs: 5000 }).catch((error) => error);
    expect(failure).toBeInstanceOf(RadarError);
    expect(failure.usage).toEqual({ inputTokens: 900, outputTokens: 0 });
  });

  it('fails on an answer that does not match the schema, keeping the tokens', async () => {
    const { provider } = fakeAnthropic(() => messageResponse({ score: 'high' }, { inputTokens: 800 }));

    const failure = await provider.score(input, { timeoutMs: 5000 }).catch((error) => error);
    expect(failure.message).toMatch(/did not match the schema/);
    expect(failure.usage.inputTokens).toBe(800);
  });
});

describe('the prediction, whichever provider', () => {
  it('clamps scores no provider range-checks, and drops a reject reason on an approve', async () => {
    const { provider } = fakeOpenAi(() =>
      responsesResponse(radarOutput({ score: 140, topic_fit: -5, predicted_rejection_reason: 'too_minor' })),
    );

    const prediction = await provider.score(input, { timeoutMs: 5000 });
    expect(prediction.score).toBe(100);
    expect(prediction.topicFit).toBe(0);
    expect(prediction.predictedRejectionReason).toBeNull();
  });

  it('keeps the predicted reason on a reject', async () => {
    const { provider } = fakeAnthropic(() =>
      messageResponse(radarOutput({ predicted_decision: 'reject', score: 20, predicted_rejection_reason: 'wrong_topic' })),
    );
    expect((await provider.score(input, { timeoutMs: 5000 })).predictedRejectionReason).toBe('wrong_topic');
  });
});

describe('choosing the provider', () => {
  const keys = { OPENAI_API_KEY: 'sk-openai', ANTHROPIC_API_KEY: 'sk-ant-key', RADAR_MODEL: undefined };

  it('uses the one RADAR_PROVIDER names', () => {
    expect(createRadarProvider({ ...keys, RADAR_PROVIDER: 'openai' })).toMatchObject({
      name: 'openai',
      model: 'gpt-6-luna',
    });
    expect(createRadarProvider({ ...keys, RADAR_PROVIDER: 'anthropic' })).toMatchObject({
      name: 'anthropic',
      model: 'claude-haiku-4-5',
    });
  });

  it('is off without that provider\'s key, even if the other one is set', () => {
    expect(createRadarProvider({ ...keys, OPENAI_API_KEY: undefined, RADAR_PROVIDER: 'openai' })).toBeNull();
    expect(createRadarProvider({ ...keys, ANTHROPIC_API_KEY: undefined, RADAR_PROVIDER: 'anthropic' })).toBeNull();
  });

  it('applies RADAR_MODEL to the configured provider only', () => {
    const env = { ...keys, RADAR_PROVIDER: 'openai' as const, RADAR_MODEL: 'gpt-6-luna-2026-09' };
    expect(createRadarProvider(env)?.model).toBe('gpt-6-luna-2026-09');
    // Resuming an Anthropic batch must not label it with an OpenAI model id.
    expect(createRadarProvider(env, 'anthropic')?.model).toBe('claude-haiku-4-5');
  });

  it('tells which provider a batch id belongs to', () => {
    expect(providerOfBatch('msgbatch_013Zva2CMHLNnXjNJJKqJ2EF')).toBe('anthropic');
    expect(providerOfBatch('batch_abc123')).toBe('openai');
    expect(providerOfBatch('something-else')).toBeNull();
  });
});
