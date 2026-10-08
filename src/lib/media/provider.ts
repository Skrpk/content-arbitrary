import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { Env } from '@/lib/env';
import type { ImageMediaType } from '@/lib/media/image';
import {
  IMAGE_UNDERSTANDING_INSTRUCTIONS,
  imageUnderstandingOutputSchema,
  MEDIA_UNDERSTANDING_DETAIL,
  toUnderstanding,
  type ImageUnderstanding,
} from '@/lib/media/understanding';

/**
 * The vision call: one image, the post's caption as context, and nothing of
 * any workspace. OpenAI's Responses API, with no reasoning — this is a short
 * factual description, not a judgement — and the image at low detail.
 */

/** The caption is context, not content; a few hundred words of it is plenty. */
const CAPTION_MAX = 1500;
/** A summary, a few labels and a line of text: well under this. */
const MAX_OUTPUT_TOKENS = 600;

export interface ImageUnderstander {
  model: string;
  understand(
    image: { bytes: Uint8Array; mediaType: ImageMediaType },
    options: { caption?: string | null; timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ understanding: ImageUnderstanding; inputTokens: number; outputTokens: number }>;
}

/** Failure with whatever usage was spent before it, so the cost is still recorded. */
export class ImageUnderstandingError extends Error {
  constructor(
    message: string,
    readonly usage?: { inputTokens: number; outputTokens: number },
  ) {
    super(message);
    this.name = 'ImageUnderstandingError';
  }
}

export function createOpenAiImageUnderstander(options: {
  apiKey?: string;
  client?: OpenAI;
  model: string;
}): ImageUnderstander {
  const client = options.client ?? new OpenAI({ apiKey: options.apiKey });
  const format = zodTextFormat(imageUnderstandingOutputSchema, 'image_understanding');

  return {
    model: options.model,

    async understand(image, { caption, timeoutMs, signal }) {
      const context = caption?.trim()
        ? `The post's caption, as context only:\n<caption>\n${caption.trim().slice(0, CAPTION_MAX)}\n</caption>`
        : 'The post has no caption.';

      const response = await client.responses.create(
        {
          model: options.model,
          instructions: IMAGE_UNDERSTANDING_INSTRUCTIONS,
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: context },
                {
                  type: 'input_image',
                  image_url: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString('base64')}`,
                  detail: MEDIA_UNDERSTANDING_DETAIL,
                },
              ],
            },
          ],
          text: { format },
          reasoning: { effort: 'none' },
          max_output_tokens: MAX_OUTPUT_TOKENS,
          // Nothing to come back to: do not keep the image on OpenAI's side.
          store: false,
        },
        { timeout: timeoutMs, maxRetries: 1, signal },
      );

      const usage = {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      };
      if (response.status !== 'completed') {
        const reason = response.incomplete_details?.reason;
        throw new ImageUnderstandingError(
          `no usable answer (status: ${response.status ?? 'unknown'}${reason ? `, ${reason}` : ''})`,
          usage,
        );
      }

      const refusal = response.output
        .flatMap((item) => (item.type === 'message' ? item.content : []))
        .find((part) => part.type === 'refusal');
      if (refusal) throw new ImageUnderstandingError(`refused: ${refusal.refusal}`, usage);

      let parsed;
      try {
        parsed = imageUnderstandingOutputSchema.parse(JSON.parse(response.output_text));
      } catch (error) {
        throw new ImageUnderstandingError(
          `unexpected answer: ${error instanceof Error ? error.message : String(error)}`,
          usage,
        );
      }
      return { understanding: toUnderstanding(parsed), ...usage };
    },
  };
}

/** The understander, or null without an OpenAI key — then images are simply not understood. */
export function createImageUnderstander(
  env: Pick<Env, 'OPENAI_API_KEY' | 'MEDIA_UNDERSTANDING_MODEL'>,
): ImageUnderstander | null {
  if (!env.OPENAI_API_KEY) return null;
  return createOpenAiImageUnderstander({ apiKey: env.OPENAI_API_KEY, model: env.MEDIA_UNDERSTANDING_MODEL });
}
