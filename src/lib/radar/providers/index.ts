import type { Env } from '@/lib/env';
import { createAnthropicRadar } from '@/lib/radar/providers/anthropic';
import { createOpenAiRadar } from '@/lib/radar/providers/openai';
import type { RadarProvider, RadarProviderName } from '@/lib/radar/providers/types';

export { ANTHROPIC_RADAR_MODEL } from '@/lib/radar/providers/anthropic';
export { OPENAI_RADAR_MODEL } from '@/lib/radar/providers/openai';
export type { RadarBatchResult, RadarProvider, RadarProviderName } from '@/lib/radar/providers/types';

/**
 * The provider RADAR_PROVIDER names, with RADAR_MODEL if set — or null when
 * that provider's API key is missing, which is what leaves Radar off.
 */
export function createRadarProvider(
  env: Pick<Env, 'RADAR_PROVIDER' | 'RADAR_MODEL' | 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY'>,
  name: RadarProviderName = env.RADAR_PROVIDER,
): RadarProvider | null {
  // RADAR_MODEL names a model of the configured provider; another provider
  // (resuming one of its batches) keeps its own default.
  const model = name === env.RADAR_PROVIDER ? env.RADAR_MODEL : undefined;
  if (name === 'openai') {
    return env.OPENAI_API_KEY ? createOpenAiRadar({ apiKey: env.OPENAI_API_KEY, model }) : null;
  }
  return env.ANTHROPIC_API_KEY ? createAnthropicRadar({ apiKey: env.ANTHROPIC_API_KEY, model }) : null;
}

/** Which provider a batch id belongs to, so a batch can be resumed whatever is configured now. */
export function providerOfBatch(batchId: string): RadarProviderName | null {
  if (batchId.startsWith('msgbatch_')) return 'anthropic';
  if (batchId.startsWith('batch_')) return 'openai';
  return null;
}
