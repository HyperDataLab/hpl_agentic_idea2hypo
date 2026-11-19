// Same checks as PaperLab's worker (paper-lab/worker/src/auth.ts) and Paper Fetch Hub's.
import { jwtVerify, type JWTVerifyGetKey } from 'jose';

export const SECURETOKEN_JWKS =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

/** True only for an address whose domain is exactly `domain`: one '@', no sub-domain, no look-alike. */
export function emailAllowed(email: unknown, domain: string): email is string {
  if (typeof email !== 'string') return false;
  const at = email.indexOf('@');
  return at > 0 && at === email.lastIndexOf('@') && email.slice(at + 1).toLowerCase() === domain;
}

export class NotAllowedError extends Error {}

export interface Identity {
  uid: string;
  email: string;
  /** Seconds since the epoch at which the token expires. */
  exp: number;
}

/**
 * Checks a Firebase ID token: Google's signature, this project as issuer and audience, a verified Google
 * account. A good token from another domain is `NotAllowedError` (403); anything else throws (401).
 */
export async function verifyFirebaseToken(
  token: string,
  jwks: JWTVerifyGetKey,
  projectId: string,
  domain: string,
): Promise<Identity> {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
    algorithms: ['RS256'],
  });
  const provider = (payload.firebase as { sign_in_provider?: string } | undefined)?.sign_in_provider;
  if (!payload.sub || payload.email_verified !== true || provider !== 'google.com')
    throw new Error('unverified account');
  if (!emailAllowed(payload.email, domain)) throw new NotAllowedError('domain not allowed');
  return { uid: payload.sub, email: payload.email, exp: Number(payload.exp ?? 0) };
}

/** Constant-time comparison of two secrets (the engine key). */
export function sameSecret(a: string, b: string): boolean {
  if (!a || !b) return false;
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1)
    diff |= (left[i % left.length] ?? 0) ^ (right[i % right.length] ?? 0);
  return diff === 0;
}
