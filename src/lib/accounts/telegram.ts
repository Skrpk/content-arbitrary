import type { JWTPayload } from 'jose';
import { z } from 'zod';
import type { Env } from '@/lib/env';
import { LoginError, type OidcProvider } from '@/lib/accounts/oidc';
import type { TelegramAccount } from '@/lib/accounts/users';

/**
 * "Log in with Telegram", as OpenID Connect: Telegram's own issuer, the
 * Client ID and Secret BotFather gives under the bot's Login Widget, and the
 * `profile` scope — which is what puts the Telegram user id in the token. The
 * OIDC `sub` is a different number; the id is the one a Mini App's signed data
 * and `workspaces.telegram_admin_chat_id` know the person by.
 */

export const TELEGRAM_ISSUER = 'https://oauth.telegram.org';

/** The provider, or null while the website has no Telegram sign-in configured. */
export function telegramLoginProvider(
  env: Pick<Env, 'TELEGRAM_OIDC_CLIENT_ID' | 'TELEGRAM_OIDC_CLIENT_SECRET'>,
): OidcProvider | null {
  if (!env.TELEGRAM_OIDC_CLIENT_ID || !env.TELEGRAM_OIDC_CLIENT_SECRET) return null;
  return {
    id: 'telegram',
    issuer: TELEGRAM_ISSUER,
    clientId: env.TELEGRAM_OIDC_CLIENT_ID,
    clientSecret: env.TELEGRAM_OIDC_CLIENT_SECRET,
    scopes: ['openid', 'profile'],
  };
}

const claimsSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().regex(/^\d{1,20}$/)]),
  name: z.string().max(256).optional(),
  preferred_username: z.string().max(64).optional(),
});

/** The Telegram account a verified ID token speaks for. */
export function telegramAccountFromClaims(claims: JWTPayload): TelegramAccount {
  const parsed = claimsSchema.safeParse(claims);
  if (!parsed.success) {
    throw new LoginError('ID token has no Telegram user id', 'failed');
  }
  return {
    id: String(parsed.data.id),
    name: parsed.data.name ?? null,
    username: parsed.data.preferred_username ?? null,
  };
}
