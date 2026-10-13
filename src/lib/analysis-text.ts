/**
 * A post's analysis-only text — a video's transcript — cut to what a prompt
 * or an embedding can take. Never published (see NormalizedPost.analysisText).
 */

/** How long Radar's sample is: a few minutes of speech, about 1,500 tokens. */
export const RADAR_ANALYSIS_MAX = 6_000;
/** And the embedding's: a third of the embedded text at most. */
export const EMBEDDING_ANALYSIS_MAX = 2_000;

/**
 * At most `max` characters of the text, deterministically, that stand for the
 * whole of it rather than its opening: all of a short one; of a long one,
 * `pieces` evenly spaced excerpts, cut at word bounds, each marked with where
 * in the text it starts — so a 90-minute video is not judged by its intro.
 */
export function sampleAnalysisText(text: string, max: number, pieces = 6): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const marker = (percent: number) => `[…${percent}%] `;
  const size = Math.floor(max / pieces) - marker(100).length - 1;
  const step = (text.length - size) / (pieces - 1);
  const excerpts: string[] = [];
  for (let index = 0; index < pieces; index += 1) {
    let start = Math.round(index * step);
    let end = Math.min(text.length, start + size);
    // To the next word boundary on either side, so no word is cut in two.
    if (start > 0) start = Math.min(end, text.indexOf(' ', start) + 1 || start);
    if (end < text.length) end = Math.max(start, text.lastIndexOf(' ', end));
    excerpts.push(`${marker(Math.round((start / text.length) * 100))}${text.slice(start, end).trim()}`);
  }
  return { text: excerpts.join('\n'), truncated: true };
}
