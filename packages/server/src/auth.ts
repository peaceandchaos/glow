import { createHash, randomBytes } from 'node:crypto';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import {
  sessionTokenBytes,
  sessionTokenSchema,
  type SessionToken,
} from '../../../shared/contracts';
import type { Database } from './database';

const appleIssuer = 'https://appleid.apple.com';
const appleAudience = 'com.peaceandchaos.glow';

function unauthorized(): Response {
  return new Response('Unauthorized', { status: 401 });
}

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function allows(allowedAppleUserIds: string, user: string): boolean {
  return allowedAppleUserIds.split(',').some(value => value.trim() === user);
}

async function verifiedClaims(
  identityToken: string,
  appleKeys: JWTVerifyGetKey,
): Promise<JWTPayload> {
  const { errors, jwtVerify } = await import('jose');
  const tokenFaults = [
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
    if (tokenFaults.some(type => error instanceof type)) throw unauthorized();
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
  return sessionTokenSchema.parse(
    randomBytes(sessionTokenBytes).toString('base64url'),
  );
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

export async function sessionOwner(
  headers: Headers,
  allowedAppleUserIds: string,
  sessions: () => Promise<SessionStore>,
): Promise<string> {
  const token = bearerToken(headers);
  const user = await (await sessions()).user(token);
  if (user === null || !allows(allowedAppleUserIds, user)) throw unauthorized();
  return user;
}
