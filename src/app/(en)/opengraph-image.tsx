import { CONTENT } from '@/marketing/content';
import { OG_IMAGE_SIZE, renderOgImage } from '@/marketing/og-image';

export const alt = CONTENT.en.meta.title;
export const size = OG_IMAGE_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderOgImage('en');
}
