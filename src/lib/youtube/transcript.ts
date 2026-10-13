import { z } from 'zod';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { truncateToLength } from '@/lib/telegram/format-caption';

/**
 * A video's transcript, for analysis: what Radar and the embedding read about
 * a video beyond its title and description. Never published.
 *
 * Behind a provider, because YouTube's own API gives a video's captions only
 * to whoever may edit it (captions.download). The first provider is Supadata,
 * asked only for the transcript a video already has — `mode=native`, never
 * an AI transcription, whose price grows with the video. Every way it can go
 * wrong ends in a result, never an exception: a video without a transcript
 * is judged on its metadata, and an outage stops nothing.
 */

export type TranscriptResult =
  | { status: 'available'; text: string; language: string | null }
  /** The video has none — a settled answer, not asked again. */
  | { status: 'unavailable' }
  | { status: 'failed'; error: string };

export interface VideoTranscriptProvider {
  name: string;
  getTranscript(videoUrl: string): Promise<TranscriptResult>;
}

const SUPADATA_URL = 'https://api.supadata.ai/v1/transcript';
const TIMEOUT_MS = 20_000;
/** A transcript kept whole up to here — a few hours of speech; past it, cut. */
export const TRANSCRIPT_STORED_MAX = 200_000;

const transcriptSchema = z.object({
  content: z.union([z.string(), z.array(z.object({ text: z.string() }).passthrough())]),
  lang: z.string().optional(),
});

export function createSupadataProvider(options: { apiKey: string; fetchImpl?: typeof fetch }): VideoTranscriptProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    name: 'supadata',
    async getTranscript(videoUrl) {
      const url = new URL(SUPADATA_URL);
      url.searchParams.set('url', videoUrl);
      url.searchParams.set('text', 'true');
      url.searchParams.set('mode', 'native');

      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: { 'x-api-key': options.apiKey, accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        return { status: 'failed', error: `Supadata did not answer: ${describeError(error)}` };
      }

      // Supadata answers "this video has no transcript" with 206.
      if (response.status === 206 || response.status === 404) return { status: 'unavailable' };
      // An asynchronous job is an AI transcription, which this never asks for.
      if (response.status === 202) return { status: 'unavailable' };
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (body.error === 'transcript-unavailable') return { status: 'unavailable' };
        return { status: 'failed', error: `Supadata: HTTP ${response.status}${body.error ? ` (${body.error})` : ''}` };
      }

      const parsed = transcriptSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) return { status: 'failed', error: 'Supadata: an answer it could not read' };
      const content = parsed.data.content;
      const text = normaliseTranscript(typeof content === 'string' ? content : content.map((chunk) => chunk.text).join(' '));
      if (text === '') return { status: 'unavailable' };
      return {
        status: 'available',
        text: text.length <= TRANSCRIPT_STORED_MAX ? text : truncateToLength(text, TRANSCRIPT_STORED_MAX),
        language: parsed.data.lang ?? null,
      };
    },
  };
}

/** A transcript as one text: whitespace evened out, caption cues like [Music] dropped. */
export function normaliseTranscript(text: string): string {
  return text
    .replace(/\[(?:music|applause|laughter|silence|музика|оплески)\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Log what came of a video's transcript, without its text. */
export function logTranscript(
  logger: Logger,
  result: TranscriptResult,
  fields: { videoId: string; provider: string; latencyMs: number },
): void {
  if (result.status === 'available') {
    logger.info('youtube.transcript_available', {
      ...fields,
      transcriptLength: result.text.length,
      transcriptLanguage: result.language,
    });
  } else if (result.status === 'unavailable') {
    logger.info('youtube.transcript_unavailable', fields);
  } else {
    logger.warn('youtube.transcript_failed', { ...fields, error: result.error });
  }
}
