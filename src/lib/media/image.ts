import { createHash } from 'node:crypto';

/**
 * An image's identity and kind, from its bytes alone.
 *
 * The fingerprint is a hash of the bytes, never of a URL: a URL can come to
 * serve another picture, and the same picture reaches us under many URLs.
 */

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

/** SHA-256 of the bytes, hex. */
export function imageFingerprint(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * What the bytes are, by their signature, or null for anything a vision model
 * is not sent: GIFs (animation is out of scope), HEIC, video, or not an image.
 */
export function sniffImageType(bytes: Uint8Array): ImageMediaType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
