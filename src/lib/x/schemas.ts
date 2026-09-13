import { z } from 'zod';

/**
 * Zod models for the X API v2 responses we consume.
 *
 * These are deliberately permissive about *extra* fields (X adds them over time)
 * but strict about the shape of what we actually read, so a change in the
 * upstream contract surfaces as a clear validation error rather than an
 * `undefined` several layers deeper.
 */

export const xMediaVariantSchema = z.object({
  bit_rate: z.number().optional(),
  content_type: z.string().optional(),
  url: z.string().optional(),
});

export const xMediaSchema = z.object({
  media_key: z.string(),
  type: z.string(),
  url: z.string().optional(),
  preview_image_url: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  duration_ms: z.number().optional(),
  variants: z.array(xMediaVariantSchema).optional(),
  alt_text: z.string().optional(),
});

export const xUrlEntitySchema = z.object({
  start: z.number(),
  end: z.number(),
  url: z.string(),
  expanded_url: z.string().optional(),
  display_url: z.string().optional(),
  /** Present when the t.co link points at media attached to this very post. */
  media_key: z.string().optional(),
});

export const xReferencedPostSchema = z.object({
  type: z.string(),
  id: z.string(),
});

export const xPostSchema = z.object({
  id: z.string(),
  text: z.string(),
  created_at: z.string().optional(),
  author_id: z.string().optional(),
  attachments: z
    .object({ media_keys: z.array(z.string()).optional() })
    .optional(),
  entities: z
    .object({ urls: z.array(xUrlEntitySchema).optional() })
    .optional(),
  referenced_tweets: z.array(xReferencedPostSchema).optional(),
  in_reply_to_user_id: z.string().optional(),
});

export const xUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string().optional(),
});

export const xTimelineResponseSchema = z.object({
  data: z.array(xPostSchema).optional(),
  includes: z
    .object({
      media: z.array(xMediaSchema).optional(),
      users: z.array(xUserSchema).optional(),
    })
    .optional(),
  meta: z
    .object({
      result_count: z.number().optional(),
      newest_id: z.string().optional(),
      oldest_id: z.string().optional(),
      next_token: z.string().optional(),
    })
    .optional(),
  errors: z
    .array(z.object({ title: z.string().optional(), detail: z.string().optional() }))
    .optional(),
});

export const xUserLookupResponseSchema = z.object({
  data: xUserSchema.optional(),
  errors: z
    .array(z.object({ title: z.string().optional(), detail: z.string().optional() }))
    .optional(),
});

export type XMedia = z.infer<typeof xMediaSchema>;
export type XPost = z.infer<typeof xPostSchema>;
export type XUser = z.infer<typeof xUserSchema>;
export type XTimelineResponse = z.infer<typeof xTimelineResponseSchema>;
export type XUrlEntity = z.infer<typeof xUrlEntitySchema>;
