import { ImageResponse } from 'next/og';
import { SITE_NAME } from '@/lib/site';
import { CONTENT } from './content';
import type { Locale } from './i18n';

/**
 * The preview card shown when the site's link is shared — in Telegram above
 * all, where it is the first thing a channel admin sees. One per language.
 */

export const OG_IMAGE_SIZE = { width: 1200, height: 630 };

export function renderOgImage(locale: Locale): ImageResponse {
  const { meta } = CONTENT[locale];

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          background: 'linear-gradient(135deg, #0e1621 0%, #17324a 60%, #229ed9 140%)',
          color: '#ffffff',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', fontSize: 34, fontWeight: 700 }}>
          <div
            style={{
              display: 'flex',
              padding: '8px 18px',
              marginRight: 20,
              borderRadius: 14,
              background: '#229ed9',
              fontSize: 30,
            }}
          >
            X → TG
          </div>
          {SITE_NAME}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 66, fontWeight: 700, lineHeight: 1.15, maxWidth: 1000 }}>
            {meta.ogHeadline}
          </div>
          <div style={{ fontSize: 36, marginTop: 24, color: '#b8d6ea' }}>{meta.ogSubline}</div>
        </div>
      </div>
    ),
    OG_IMAGE_SIZE,
  );
}
