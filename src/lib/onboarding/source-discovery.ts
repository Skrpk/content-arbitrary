import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { isBlockedDomain, registrableDomain, type Candidate, type CandidateKind } from '@/lib/onboarding/candidates';
import { normalizeChannelUsername } from '@/lib/telegram-channel/username';
import { normalizeYouTubeChannel } from '@/lib/youtube/channel';

/**
 * Sources found on the web for a channel (§15 C, D6): one bounded model call
 * with web search, given what the channel publishes and what its history
 * already points at, asked for reputable sources that publish original
 * information on its topics — primary ones first.
 *
 * Its answers are hints only: every one is resolved and checked before it is
 * used (src/lib/onboarding/discover-sources.ts). X and Threads are never asked
 * for (D4).
 */

const KINDS = ['official', 'specialist', 'curator', 'creator', 'aggregator'] as const satisfies readonly CandidateKind[];

const suggestionsSchema = z.object({
  sources: z.array(
    z.object({
      name: z.string(),
      platform: z.enum(['telegram', 'youtube', 'website']),
      url: z.string(),
      organization: z.string(),
      kind: z.enum(KINDS),
      reason: z.string(),
    }),
  ),
});

export type SourceSuggestions = z.infer<typeof suggestionsSchema>;

export interface DiscoveryInput {
  channelTitle: string;
  /** The channel's language, BCP 47; its sources may be in others. */
  language: string | null;
  editorialProfile: string | null;
  topics: string[];
  /** What its history already points at, so the search complements rather than repeats it. */
  known: { name: string; evidence: string }[];
  /** Never suggested: the channel's own site, its own username. */
  exclude: string[];
}

export interface SourceDiscoverer {
  readonly model: string;
  discover(input: DiscoveryInput, options: { timeoutMs: number }): Promise<{ suggestions: SourceSuggestions['sources']; webSearches: number; usage: { inputTokens: number; outputTokens: number } }>;
}

const INSTRUCTIONS = `You find news sources for a Telegram channel's editor: places that regularly publish original information on the channel's topics, which the editor would want to follow to find stories first.

Search the web to find and check them. Suggest 10 to 15, in this order of preference:
1. official and primary sources: the companies, organisations, agencies and people the channel's topics are about — their newsrooms, blogs, official channels;
2. specialist publications on those topics;
3. niche curators and newsletters that reliably surface such news early;
4. quality creators who cover them.
A big generic news outlet only when it covers the topic in depth; never only big generic media.

Rules:
- platform: "website" (give its home page URL), "telegram" (a public channel: https://t.me/name) or "youtube" (a channel: https://www.youtube.com/@handle). Nothing else — no X, no Threads, no Facebook, Instagram or TikTok.
- Only sources that exist and are active now; give their real URLs, as you found them.
- Prefer sources in the channel's language and region when they exist, and include the original international sources its topics come from.
- Never suggest the channel itself, or anything in the exclude list. Do not repeat the sources it already uses (listed); find others.
- organization: who is behind the source (a company, publisher or person), so two outlets of one organisation can be told apart.
- kind: official, specialist, curator, creator or aggregator.
- reason: one short sentence, in the channel's language, on why it fits this channel — what it publishes that the channel picks up.`;

export function createOpenAiDiscoverer(options: { apiKey?: string; client?: OpenAI; model: string }): SourceDiscoverer {
  const client = options.client ?? new OpenAI({ apiKey: options.apiKey });
  return {
    model: options.model,
    async discover(input, { timeoutMs }) {
      const response = await client.responses.create(
        {
          model: options.model,
          instructions: INSTRUCTIONS,
          input: discoveryPrompt(input),
          tools: [{ type: 'web_search', search_context_size: 'medium' }],
          text: { format: zodTextFormat(suggestionsSchema, 'source_suggestions') },
          reasoning: { effort: 'low' },
          max_output_tokens: 12_000,
          store: false,
        },
        { timeout: timeoutMs, maxRetries: 1 },
      );
      const parsed = suggestionsSchema.parse(JSON.parse(response.output_text));
      const webSearches = response.output.filter((item) => item.type === 'web_search_call').length;
      return {
        suggestions: parsed.sources,
        webSearches,
        usage: { inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 },
      };
    },
  };
}

export function discoveryPrompt(input: DiscoveryInput): string {
  return [
    `<channel>${input.channelTitle}</channel>`,
    `<language>${input.language ?? 'unknown'}</language>`,
    input.editorialProfile ? `<editorial_profile>\n${input.editorialProfile}\n</editorial_profile>` : '',
    input.topics.length > 0 ? `<topics>\n${input.topics.map((topic) => `- ${topic}`).join('\n')}\n</topics>` : '',
    input.known.length > 0 ? `<already_uses>\n${input.known.map((source) => `- ${source.name} (${source.evidence})`).join('\n')}\n</already_uses>` : '',
    input.exclude.length > 0 ? `<exclude>\n${input.exclude.map((item) => `- ${item}`).join('\n')}\n</exclude>` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** A suggestion as a candidate, or null for one that names nothing Zmistik can follow. */
export function suggestionToCandidate(suggestion: SourceSuggestions['sources'][number]): Candidate | null {
  const base = {
    name: suggestion.name.trim() || null,
    origin: 'discovery' as const,
    links: 0,
    forwards: 0,
    reason: suggestion.reason.trim() || null,
    kind: suggestion.kind,
    organization: suggestion.organization.trim().toLowerCase() || null,
  };
  if (suggestion.platform === 'telegram') {
    const name = normalizeChannelUsername(suggestion.url);
    return name.ok ? { ...base, key: `telegram:${name.username}`, platform: 'telegram', target: name.username } : null;
  }
  if (suggestion.platform === 'youtube') {
    const channel = normalizeYouTubeChannel(suggestion.url);
    if (!channel.ok) return null;
    const ref = channel.channel.kind === 'id' ? channel.channel.id : `@${channel.channel.handle}`;
    return { ...base, key: `youtube:${ref}`, platform: 'youtube', target: suggestion.url };
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(suggestion.url) ? suggestion.url : `https://${suggestion.url}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const domain = registrableDomain(host);
  if (isBlockedDomain(domain) || domain === 'youtube.com' || host === 't.me') return null;
  return { ...base, key: `site:${domain}`, platform: 'website', target: `https://${url.hostname}/`, organization: base.organization ?? domain };
}

/** The web search as the app has it: OpenAI, with the assistant's model; null without a key. */
export function createDiscoverer(env: { OPENAI_API_KEY?: string; ASSISTANT_MODEL: string }): SourceDiscoverer | null {
  return env.OPENAI_API_KEY ? createOpenAiDiscoverer({ apiKey: env.OPENAI_API_KEY, model: env.ASSISTANT_MODEL }) : null;
}
