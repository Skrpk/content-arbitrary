import type { SourceMetadata } from '@/db/schema';
import { RADAR_ANALYSIS_MAX, sampleAnalysisText } from '@/lib/analysis-text';
import type { Logger } from '@/lib/logger';

/**
 * What Radar is told of a post beyond its text, the same live and on a
 * backfill: how its media is described, and the bounded sample of its
 * analysis-only text — a video's transcript.
 */

/** "YouTube video, 12 min" for a video; otherwise the description the post's media already has. */
export function radarMediaOf(input: { platform: string | undefined; media: string; metadata?: SourceMetadata | null }): string {
  if (input.platform !== 'youtube') return input.media;
  const seconds = input.metadata?.durationSeconds;
  if (!seconds) return 'YouTube video';
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `YouTube video, ${minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`}`;
}

/** The sample of a post's analysis text Radar reads; null for a post with none. Says when it was cut. */
export function radarAnalysisOf(text: string | null | undefined, logger?: Logger, fields?: Record<string, unknown>): string | null {
  if (!text?.trim()) return null;
  const sample = sampleAnalysisText(text, RADAR_ANALYSIS_MAX);
  if (sample.truncated) logger?.info('radar.analysis_sampled', { ...fields, length: text.length, sampled: sample.text.length });
  return sample.text;
}
