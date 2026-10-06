import { z } from 'zod';
import { truncateToLength } from '@/lib/telegram/format-caption';

/**
 * The shapes a publication-history profile passes through: the notes a model
 * writes on one batch of past posts, and the final profile written from all
 * the notes.
 *
 * Models are not trusted to respect lengths, so these schemas only constrain
 * shape; `normalise*` trims what comes back to the sizes below and drops any
 * representative id that is not one of the posts the model was shown.
 */

export const TOPIC_STRENGTHS = ['high', 'medium', 'low'] as const;

/** What a model notes about one batch of past posts, or about several merged notes. */
export const historyNotesSchema = z.object({
  topics: z.array(
    z.object({
      name: z.string(),
      share: z.enum(['dominant', 'frequent', 'occasional']),
      description: z.string(),
    }),
  ),
  angles: z.array(z.string()),
  contentPatterns: z.array(z.string()),
  toneNotes: z.array(z.string()),
  formattingNotes: z.array(z.string()),
  hooks: z.array(z.string()),
  entities: z.array(z.string()),
  representativeCandidates: z.array(z.object({ id: z.number().int(), pattern: z.string() })),
});

export type HistoryNotes = z.infer<typeof historyNotesSchema>;

export const publicationProfileSchema = z.object({
  summary: z.string(),
  coreTopics: z.array(
    z.object({ name: z.string(), strength: z.enum(TOPIC_STRENGTHS), description: z.string() }),
  ),
  recurringAngles: z.array(z.string()),
  contentPatterns: z.array(z.string()),
  tone: z.object({
    language: z.string(),
    voice: z.string(),
    technicality: z.string(),
    sensationalism: z.string(),
    humor: z.string(),
  }),
  formatting: z.object({
    typicalLength: z.string(),
    paragraphStyle: z.string(),
    headlineStyle: z.string(),
    emojiUsage: z.string(),
  }),
  hooks: z.array(z.string()),
  recurringEntities: z.array(z.string()),
  representativeItemIds: z.array(z.number().int()),
  observations: z.array(z.string()),
  caveats: z.array(z.string()),
});

export type PublicationProfile = z.infer<typeof publicationProfileSchema>;

const LIMITS = {
  topics: 12,
  list: 8,
  entities: 25,
  representatives: 10,
  candidates: 6,
  text: 400,
  summary: 800,
};

/** Trim the notes to size and keep only candidates the batch actually contained. */
export function normaliseNotes(notes: HistoryNotes, shownIds: ReadonlySet<number>): HistoryNotes {
  const seen = new Set<number>();
  return {
    topics: notes.topics.slice(0, LIMITS.topics).map((topic) => ({
      name: short(topic.name, 80),
      share: topic.share,
      description: short(topic.description),
    })),
    angles: list(notes.angles),
    contentPatterns: list(notes.contentPatterns),
    toneNotes: list(notes.toneNotes),
    formattingNotes: list(notes.formattingNotes),
    hooks: list(notes.hooks),
    entities: list(notes.entities, LIMITS.entities, 60),
    representativeCandidates: notes.representativeCandidates
      .filter((candidate) => shownIds.has(candidate.id) && !seen.has(candidate.id) && seen.add(candidate.id))
      .slice(0, LIMITS.candidates)
      .map((candidate) => ({ id: candidate.id, pattern: short(candidate.pattern, 200) })),
  };
}

/** Trim the profile to size and keep only representative ids from the source history. */
export function normaliseProfile(
  profile: PublicationProfile,
  sourceIds: ReadonlySet<number>,
): PublicationProfile {
  return {
    summary: short(profile.summary, LIMITS.summary),
    coreTopics: profile.coreTopics.slice(0, LIMITS.topics).map((topic) => ({
      name: short(topic.name, 80),
      strength: topic.strength,
      description: short(topic.description),
    })),
    recurringAngles: list(profile.recurringAngles),
    contentPatterns: list(profile.contentPatterns),
    tone: {
      language: short(profile.tone.language, 80),
      voice: short(profile.tone.voice),
      technicality: short(profile.tone.technicality),
      sensationalism: short(profile.tone.sensationalism),
      humor: short(profile.tone.humor),
    },
    formatting: {
      typicalLength: short(profile.formatting.typicalLength),
      paragraphStyle: short(profile.formatting.paragraphStyle),
      headlineStyle: short(profile.formatting.headlineStyle),
      emojiUsage: short(profile.formatting.emojiUsage),
    },
    hooks: list(profile.hooks),
    recurringEntities: list(profile.recurringEntities, LIMITS.entities, 60),
    representativeItemIds: [...new Set(profile.representativeItemIds)]
      .filter((id) => sourceIds.has(id))
      .slice(0, LIMITS.representatives),
    observations: list(profile.observations),
    caveats: list(profile.caveats),
  };
}

/**
 * The profile as Radar's prompt carries it: compact plain text, no ids. The
 * strings come from a model that read the channel's posts, so the caller
 * still neutralises them before they go into a tagged prompt section.
 */
export function renderPublicationProfile(profile: PublicationProfile): string {
  const joined = (items: string[]) => items.join('; ');
  const lines = [
    `Summary: ${profile.summary}`,
    `Core topics: ${profile.coreTopics
      .map((topic) => `${topic.name} (${topic.strength}) — ${topic.description}`)
      .join('; ')}`,
    profile.recurringAngles.length > 0 ? `Recurring angles: ${joined(profile.recurringAngles)}` : null,
    profile.contentPatterns.length > 0 ? `Content patterns: ${joined(profile.contentPatterns)}` : null,
    `Tone: ${profile.tone.language}; voice: ${profile.tone.voice}; technicality: ${profile.tone.technicality}; ` +
      `sensationalism: ${profile.tone.sensationalism}; humor: ${profile.tone.humor}`,
    `Format: length: ${profile.formatting.typicalLength}; paragraphs: ${profile.formatting.paragraphStyle}; ` +
      `openings: ${profile.formatting.headlineStyle}; emoji: ${profile.formatting.emojiUsage}`,
    profile.hooks.length > 0 ? `Typical hooks: ${joined(profile.hooks)}` : null,
    profile.recurringEntities.length > 0 ? `Recurring names: ${profile.recurringEntities.join(', ')}` : null,
    profile.observations.length > 0 ? `Observations: ${joined(profile.observations)}` : null,
    profile.caveats.length > 0 ? `Caveats: ${joined(profile.caveats)}` : null,
  ];
  return lines.filter((line): line is string => line !== null).join('\n');
}

function short(text: string, max = LIMITS.text): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length <= max ? trimmed : `${truncateToLength(trimmed, max)}…`;
}

function list(items: string[], max = LIMITS.list, length = LIMITS.text): string[] {
  return items
    .map((item) => short(item, length))
    .filter((item) => item !== '')
    .slice(0, max);
}
