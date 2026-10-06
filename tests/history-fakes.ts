import type { HistoryNotes, PublicationProfile } from '@/lib/history/profile/schema';
import { fakeOpenAi, responsesResponse } from './radar-fakes';

/** A profile as a model might write it. */
export function profileFixture(overrides: Partial<PublicationProfile> = {}): PublicationProfile {
  return {
    summary: 'A Ukrainian channel about space, astronomy and classic science fiction.',
    coreTopics: [{ name: 'astronomy imagery', strength: 'high', description: 'Telescope images with short captions.' }],
    recurringAngles: ['a discovery explained through one striking number'],
    contentPatterns: ['striking image with a two-paragraph caption'],
    tone: {
      language: 'Ukrainian',
      voice: 'enthusiastic popular science',
      technicality: 'moderate',
      sensationalism: 'low to moderate',
      humor: 'rare',
    },
    formatting: {
      typicalLength: 'about 400 characters',
      paragraphStyle: 'two or three short paragraphs',
      headlineStyle: 'opens with an emoji and a bold claim',
      emojiUsage: 'one or two per post',
    },
    hooks: ['a question to the reader'],
    recurringEntities: ['NASA', 'JWST', 'Mars'],
    representativeItemIds: [1, 2],
    observations: ['ends with a link to the channel'],
    caveats: ['covers two months only'],
    ...overrides,
  };
}

export function notesFixture(candidateIds: number[]): HistoryNotes {
  return {
    topics: [{ name: 'astronomy', share: 'dominant', description: 'Telescope images.' }],
    angles: ['one striking number'],
    contentPatterns: ['image with caption'],
    toneNotes: ['enthusiastic'],
    formattingNotes: ['short paragraphs'],
    hooks: ['a question'],
    entities: ['JWST'],
    representativeCandidates: candidateIds.map((id) => ({ id, pattern: `pattern of ${id}` })),
  };
}

/**
 * A profiler model behind a real OpenAI client: notes name every post they
 * were shown as a candidate, merges keep every candidate, and the profile
 * nominates them all plus one id that does not exist.
 */
export function fakeProfiler(options: { profile?: (candidates: number[]) => unknown } = {}) {
  const calls: { kind: 'notes' | 'merge' | 'profile'; input: string }[] = [];
  const fake = fakeOpenAi((body) => {
    const format = (body.text as { format: { name: string } }).format.name;
    const input = ((body.input as { content: { text: string }[] }[])[0]!.content[0]!).text;
    if (format === 'history_notes') {
      const merge = input.startsWith('Notes 1:');
      calls.push({ kind: merge ? 'merge' : 'notes', input });
      const ids = merge
        ? [...input.matchAll(/"id":(\d+)/g)].map((match) => Number(match[1]))
        : [...input.matchAll(/<item id="(\d+)"/g)].map((match) => Number(match[1]));
      return responsesResponse(notesFixture(ids), { inputTokens: 5000, outputTokens: 800 });
    }
    calls.push({ kind: 'profile', input });
    const candidates = [...input.matchAll(/"id":(\d+)/g)].map((match) => Number(match[1]));
    return responsesResponse(
      options.profile?.(candidates) ?? profileFixture({ representativeItemIds: [...candidates, 999_999] }),
      { inputTokens: 3000, outputTokens: 1500 },
    );
  });
  return { ...fake, calls };
}
