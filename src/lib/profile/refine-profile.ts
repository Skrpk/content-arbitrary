import { z } from 'zod';
import { EDITORIAL_PROFILE_MAX_LENGTH, editorialProfileLength } from '@/lib/radar/editorial-profile';
import type { TokenUsage } from '@/lib/radar/output';
import type { RadarProvider } from '@/lib/radar/providers/types';

/**
 * 💬 Уточнити (§14a): the editorial profile rewritten to apply what the
 * editor asked for, in one call. Nothing is saved here — the bot shows the
 * draft and saves it only on ✅.
 *
 * Unlike the profile onboarding writes (src/lib/onboarding/initial-profile.ts),
 * this one may say what the channel turns down: the editor said so.
 */

export const REFINE_PROFILE_PROMPT_VERSION = 'refine-profile-v1';

const answerSchema = z.object({ editorialProfile: z.string() });

const INSTRUCTIONS = `You edit the editorial profile of a Telegram channel: a short brief, in the editor's voice, that a news-scoring model reads to judge whether a new item fits the channel.

You are given the current profile and the editor's instruction. Rewrite the profile so it follows the instruction:
- apply exactly what the instruction asks — topics to add, drop, weigh more or less, things to avoid;
- keep everything the instruction does not touch;
- the editor's stated dislikes and exclusions belong in the profile;
- write in the language of the current profile, unless the instruction asks for another;
- at most ${EDITORIAL_PROFILE_MAX_LENGTH} characters; plain prose or short lines, no headings, no markdown.

If there is no current profile, write one from the instruction alone.`;

export async function refineProfile(input: {
  provider: RadarProvider;
  channelName: string;
  profile: string | null;
  instruction: string;
  timeoutMs?: number;
}): Promise<{ editorialProfile: string; usage: TokenUsage }> {
  const { output, usage } = await input.provider.complete({
    instructions: INSTRUCTIONS,
    input: [
      `<channel_name>${input.channelName}</channel_name>`,
      `<current_profile>\n${input.profile ?? ''}\n</current_profile>`,
      `<instruction>\n${input.instruction}\n</instruction>`,
    ].join('\n'),
    schema: answerSchema,
    schemaName: 'refined_editorial_profile',
    maxOutputTokens: 2_000,
    timeoutMs: input.timeoutMs ?? 45_000,
  });

  let profile = output.editorialProfile.trim();
  if (editorialProfileLength(profile) > EDITORIAL_PROFILE_MAX_LENGTH) {
    profile = Array.from(profile).slice(0, EDITORIAL_PROFILE_MAX_LENGTH).join('').trim();
  }
  return { editorialProfile: profile, usage };
}
