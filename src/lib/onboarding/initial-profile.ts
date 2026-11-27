import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { workspaces, type Workspace } from '@/db/schema';
import type { Database } from '@/lib/db';
import type { PublicationProfile } from '@/lib/history/profile/schema';
import { EDITORIAL_PROFILE_MAX_LENGTH, editorialProfileLength } from '@/lib/radar/editorial-profile';
import type { TokenUsage } from '@/lib/radar/output';
import type { RadarProvider } from '@/lib/radar/providers/types';

/**
 * The first editorial profile of a channel onboarded in the bot (§14) —
 * what Radar scores news against — and the language it publishes in, both
 * written from its publication profile (what its history shows) in one call.
 *
 * It describes what the channel publishes and nothing it was not seen to
 * turn down: a topic absent from 100 posts is not one the editor rejects.
 * Stored as `auto`; a person's profile (`editor`, or one from before this was
 * recorded) is never overwritten, nor a language already set.
 */

export const INITIAL_PROFILE_PROMPT_VERSION = 'initial-profile-v1';

const answerSchema = z.object({
  editorialProfile: z.string(),
  languageCode: z.string(),
  topics: z.array(z.string()),
});

const INSTRUCTIONS = `You write the editorial profile of a Telegram channel: a short brief, in the editor's voice, that a news-scoring model reads to judge whether a new item fits the channel.

You are given an analysis of the channel's own recent posts. From it, write:

1. editorialProfile — at most ${EDITORIAL_PROFILE_MAX_LENGTH} characters, in the channel's own language. Cover:
   - what the channel is about: its core topics, most important first;
   - what kind of items it picks: news, releases, analysis, deals, humour…;
   - its angle and audience, when the analysis shows them.
   Describe only what the channel publishes. Do not invent dislikes or exclusions: a topic missing from the posts is not one the editor rejects. Plain prose or short lines; no headings, no markdown.

2. languageCode — the language the channel publishes in, as a BCP 47 code: "uk", "en", "de", "pt-BR"… The language of the posts, not of the analysis.

3. topics — the channel's 3 or 4 main topics, most important first, each 2–5 words, in the channel's own language. They are shown to the channel's owner as "the channel is mostly about: …".`;

/** The model's answer, checked: a profile within the limit, and a language code the column accepts — or null. */
export function normaliseInitialProfile(answer: z.infer<typeof answerSchema>): {
  editorialProfile: string | null;
  language: string | null;
  topics: string[];
} {
  let profile = answer.editorialProfile.trim();
  if (editorialProfileLength(profile) > EDITORIAL_PROFILE_MAX_LENGTH) {
    profile = Array.from(profile).slice(0, EDITORIAL_PROFILE_MAX_LENGTH).join('').trim();
  }
  const language = answer.languageCode.trim().replace(/_/g, '-');
  const [primary, ...rest] = language.split('-');
  const normalised = [primary?.toLowerCase() ?? '', ...rest].join('-');
  return {
    editorialProfile: profile === '' ? null : profile,
    language: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(normalised) ? normalised : null,
    topics: answer.topics
      .map((topic) => topic.trim())
      .filter(Boolean)
      .slice(0, 4)
      .map((topic) => (topic.length > 80 ? `${topic.slice(0, 79)}…` : topic)),
  };
}

export async function writeInitialProfile(input: {
  db: Database;
  provider: RadarProvider;
  workspace: Pick<Workspace, 'id' | 'name' | 'editorialProfile' | 'editorialProfileSource' | 'language'>;
  publication: PublicationProfile;
  timeoutMs?: number;
}): Promise<{
  editorialProfile: string | null;
  language: string | null;
  topics: string[];
  written: { profile: boolean; language: boolean };
  usage: TokenUsage;
}> {
  const { output, usage } = await input.provider.complete({
    instructions: INSTRUCTIONS,
    input: `<channel_name>${input.workspace.name}</channel_name>\n<publication_analysis>\n${JSON.stringify(input.publication, null, 2)}\n</publication_analysis>`,
    schema: answerSchema,
    schemaName: 'initial_editorial_profile',
    maxOutputTokens: 2_000,
    timeoutMs: input.timeoutMs ?? 120_000,
  });
  const answer = normaliseInitialProfile(output);

  // Onboarding's own earlier profile is replaced; a person's never is.
  const mayWriteProfile =
    answer.editorialProfile !== null && (input.workspace.editorialProfile === null || input.workspace.editorialProfileSource === 'auto');
  const mayWriteLanguage = answer.language !== null && input.workspace.language === null;

  if (mayWriteProfile || mayWriteLanguage) {
    await input.db
      .update(workspaces)
      .set({
        ...(mayWriteProfile ? { editorialProfile: answer.editorialProfile, editorialProfileSource: 'auto' as const } : {}),
        ...(mayWriteLanguage ? { language: answer.language } : {}),
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, input.workspace.id));
  }
  return { ...answer, written: { profile: mayWriteProfile, language: mayWriteLanguage }, usage };
}
