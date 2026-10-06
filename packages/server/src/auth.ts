import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import {
  sessionTokenSchema,
  type SessionToken,
} from '../../../shared/contracts';
import type { Database } from './database';

const devicePattern = /^[A-Za-z0-9_-]{43,128}$/u;

export function deviceOwner(headers: Headers, allowlist: string): string {
  const device = headers.get('X-Device-Id');
  if (!device || !devicePattern.test(device)) {
    throw new Response('Unauthorized', { status: 401 });
  }
  const candidate = createHash('sha256').update(device).digest();
  const allowed = allowlist
    .split(',')
    .map(value => value.trim())
    .some(value => {
      if (!devicePattern.test(value)) return false;
      const expected = createHash('sha256').update(value).digest();
      return timingSafeEqual(candidate, expected);
    });
  if (!allowed) throw new Response('Unauthorized', { status: 401 });
  return candidate.toString('hex');
}

const appleIssuer = 'https://appleid.apple.com';
const appleAudience = 'com.peaceandchaos.glow';

function unauthorized(): Response {
  return new Response('Unauthorized', { status: 401 });
}

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function allows(allowlist: string, user: string): boolean {
  return allowlist.split(',').some(value => value.trim() === user);
}

// jose is ESM-only and the server's Jest runs CommonJS, so jose loads on
// first use, as jev.ts loads the AI SDK.
async function verifiedClaims(
  identityToken: string,
  appleKeys: JWTVerifyGetKey,
): Promise<JWTPayload> {
  const { errors, jwtVerify } = await import('jose');
  // Faults in the token itself. Anything else, such as Apple's key set timing
  // out, is the server's failure and must not read as a refused sign-in.
  const rejectedToken = [
    errors.JWSInvalid,
    errors.JWTInvalid,
    errors.JWSSignatureVerificationFailed,
    errors.JWTClaimValidationFailed,
    errors.JWTExpired,
    errors.JOSEAlgNotAllowed,
    errors.JWKSNoMatchingKey,
    errors.JWKSMultipleMatchingKeys,
  ];
  try {
    const { payload } = await jwtVerify(identityToken, appleKeys, {
      algorithms: ['RS256'],
      issuer: appleIssuer,
      audience: appleAudience,
      requiredClaims: ['exp', 'sub', 'nonce'],
    });
    return payload;
  } catch (error) {
    if (rejectedToken.some(type => error instanceof type)) throw unauthorized();
    throw error;
  }
}

export async function appleUser(
  identityToken: string,
  rawNonce: string,
  appleKeys: JWTVerifyGetKey,
): Promise<string> {
  const claims = await verifiedClaims(identityToken, appleKeys);
  if (claims.nonce !== sha256hex(rawNonce) || !claims.sub) throw unauthorized();
  return claims.sub;
}

export function newSessionToken(): SessionToken {
  return sessionTokenSchema.parse(randomBytes(32).toString('base64url'));
}

export class SessionStore {
  constructor(private readonly database: Database) {}

  async create(token: SessionToken, user: string): Promise<void> {
    await this.database.query(
      'INSERT INTO sessions (token_hash, user_id) VALUES ($1, $2)',
      [sha256hex(token), user],
    );
  }

  async user(token: SessionToken): Promise<string | null> {
    const { rows } = await this.database.query(
      'SELECT user_id AS data FROM sessions WHERE token_hash = $1',
      [sha256hex(token)],
    );
    return rows.at(0)?.data ?? null;
  }

  async revoke(token: SessionToken): Promise<void> {
    await this.database.query('DELETE FROM sessions WHERE token_hash = $1', [
      sha256hex(token),
    ]);
  }
}

export function bearerToken(headers: Headers): SessionToken {
  const credential = /^Bearer (.+)$/u.exec(headers.get('Authorization') ?? '');
  const token = sessionTokenSchema.safeParse(credential?.[1]);
  if (!token.success) throw unauthorized();
  return token.data;
}

// Malformed tokens never reach the database. This reads the allowlist on
// every call, so removing a user and redeploying locks out their sessions.
export async function sessionOwner(
  headers: Headers,
  allowlist: string,
  sessions: () => Promise<SessionStore>,
): Promise<string> {
  const token = bearerToken(headers);
  const user = await (await sessions()).user(token);
  if (user === null || !allows(allowlist, user)) throw unauthorized();
  return user;
}
