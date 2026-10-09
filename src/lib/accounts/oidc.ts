import { createHash } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { loginAttempts, type IdentityProvider } from '@/db/schema';
import type { Database } from '@/lib/db';
import { hashToken, randomToken } from '@/lib/accounts/sessions';

/**
 * Sign-in with OpenID Connect: the Authorization Code flow with PKCE, the
 * code exchanged server side with the client secret, and the ID token's
 * signature, issuer, audience, expiry and nonce checked before anything in it
 * is believed.
 *
 * Nothing here is particular to one provider. Telegram is the first; Google,
 * or Auth0 in front of anything, is another `OidcProvider` with its own
 * issuer and credentials.
 */

export interface OidcProvider {
  id: IdentityProvider;
  /** The issuer, exactly as its ID tokens state it; its discovery document is read from there. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

/** How long a sign-in may take between leaving for the provider and coming back. */
export const LOGIN_ATTEMPT_TTL_MS = 10 * 60 * 1000;

const discoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
});

type Discovery = z.infer<typeof discoverySchema>;

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const discoveries = new Map<string, { value: Discovery; fetchedAt: number }>();
const keySets = new Map<string, JWTVerifyGetKey>();

/** The provider's endpoints, from its discovery document; cached for an hour. */
export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<Discovery> {
  const cached = discoveries.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.value;

  const response = await fetchImpl(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`OIDC discovery for ${issuer} failed: HTTP ${response.status}`);
  const value = discoverySchema.parse(await response.json());
  // A discovery document speaking for another issuer is not this provider's.
  if (value.issuer !== issuer) throw new Error(`OIDC discovery for ${issuer} names issuer ${value.issuer}`);

  discoveries.set(issuer, { value, fetchedAt: Date.now() });
  return value;
}

/**
 * Begin a sign-in: remember the PKCE verifier and nonce under the `state`,
 * and return the provider URL to send the browser to. The caller also hands
 * the browser `state` in a cookie, so the callback can tell its own sign-in
 * from one started elsewhere.
 */
export async function startLogin(
  db: Database,
  provider: OidcProvider,
  input: { redirectUri: string; returnTo?: string | null; now?: Date; fetchImpl?: typeof fetch },
): Promise<{ url: string; state: string }> {
  const now = input.now ?? new Date();
  const { authorization_endpoint: authorize } = await discover(provider.issuer, input.fetchImpl);

  const state = randomToken();
  const codeVerifier = randomToken();
  const nonce = randomToken();

  // Abandoned attempts go as new ones come.
  await db.delete(loginAttempts).where(lt(loginAttempts.expiresAt, now));
  await db.insert(loginAttempts).values({
    stateHash: hashToken(state),
    provider: provider.id,
    codeVerifier,
    nonce,
    returnTo: input.returnTo ?? null,
    expiresAt: new Date(now.getTime() + LOGIN_ATTEMPT_TTL_MS),
  });

  const url = new URL(authorize);
  url.search = new URLSearchParams({
    client_id: provider.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: provider.scopes.join(' '),
    state,
    code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
    code_challenge_method: 'S256',
    nonce,
  }).toString();

  return { url: url.toString(), state };
}

export class LoginError extends Error {
  constructor(
    message: string,
    /** What the sign-in page tells the person: it ran out of time, or it failed. */
    readonly code: 'expired' | 'failed',
  ) {
    super(message);
    this.name = 'LoginError';
  }
}

const tokenResponseSchema = z.object({ id_token: z.string().min(1) });

/**
 * Finish a sign-in the provider sent back: use up the attempt `state` names,
 * exchange the code, and verify the ID token. Returns its claims, and where
 * the sign-in meant to land.
 */
export async function finishLogin(
  db: Database,
  provider: OidcProvider,
  input: {
    state: string;
    code: string;
    redirectUri: string;
    now?: Date;
    fetchImpl?: typeof fetch;
    /** The keys to check the ID token with; by default, the provider's published set. */
    keys?: JWTVerifyGetKey;
  },
): Promise<{ claims: JWTPayload; returnTo: string | null }> {
  const now = input.now ?? new Date();
  const fetchImpl = input.fetchImpl ?? fetch;

  // Deleted as it is read: an attempt is good for one callback, however many arrive.
  const [attempt] = await db
    .delete(loginAttempts)
    .where(
      and(
        eq(loginAttempts.stateHash, hashToken(input.state)),
        eq(loginAttempts.provider, provider.id),
        gt(loginAttempts.expiresAt, now),
      ),
    )
    .returning();
  if (!attempt) throw new LoginError('no such login attempt', 'expired');

  const { token_endpoint: tokenEndpoint, jwks_uri: jwksUri } = await discover(provider.issuer, fetchImpl);
  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${provider.clientId}:${provider.clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: provider.clientId,
      code_verifier: attempt.codeVerifier,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new LoginError(`token exchange failed: HTTP ${response.status}`, 'failed');
  }
  const { id_token: idToken } = tokenResponseSchema.parse(await response.json());

  let keys = input.keys ?? keySets.get(jwksUri);
  if (!keys) {
    const remote = createRemoteJWKSet(new URL(jwksUri));
    keySets.set(jwksUri, remote);
    keys = remote;
  }

  let claims: JWTPayload;
  try {
    ({ payload: claims } = await jwtVerify(idToken, keys, {
      issuer: provider.issuer,
      audience: provider.clientId,
      currentDate: now,
    }));
  } catch (error) {
    throw new LoginError(
      `ID token rejected: ${error instanceof Error ? error.message : String(error)}`,
      'failed',
    );
  }

  // Asked for, so if the provider echoes one it must be ours.
  if (claims.nonce !== undefined && claims.nonce !== attempt.nonce) {
    throw new LoginError('ID token nonce mismatch', 'failed');
  }

  return { claims, returnTo: attempt.returnTo };
}

/** Forget cached discovery documents and keys; for tests. */
export function resetOidcCache(): void {
  discoveries.clear();
  keySets.clear();
}
