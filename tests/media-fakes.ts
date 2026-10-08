import type { ImageUnderstanding } from '@/lib/media/understanding';

/** Bytes that read as a JPEG, distinct by `seed`. */
export const jpeg = (seed = 1) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, seed, 2, 3, 4]);

/** What a vision model might say of a photo of an aurora from the ISS. */
export const aurora: ImageUnderstanding = {
  summary: "View from the ISS of a green aurora over Earth's night side, city lights below.",
  contentType: 'photo',
  topics: ['aurora', 'ISS', 'Earth observation'],
  entities: ['Earth', 'ISS'],
  visibleText: null,
  informationValue: 'essential',
};
