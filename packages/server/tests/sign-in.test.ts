import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { createHash } from 'node:crypto';
import { appleUser, newSessionToken, sessionOwner } from '../src/auth';
import { testDatabase } from './database';
import { signedIn } from './sessions';

// A local RS256 key set stands in for Apple's, so no test calls Apple.
const appleUserId = 'apple-user-1';
const rawNonce = 'raw-nonce-from-the-app';
// jose is ESM-only, so this CommonJS test loads it with import().
let jose: typeof import('jose');
let signingKey: CryptoKey;
let appleKeys: JWTVerifyGetKey;

beforeAll(async () => {
  jose = await import('jose');
  const pair = await jose.generateKeyPair('RS256');
  signingKey = pair.privateKey;
  const publicJwk = await jose.exportJWK(pair.publicKey);
  appleKeys = jose.createLocalJWKSet({
    keys: [{ ...publicJwk, kid: 'local', alg: 'RS256' }],
  });
});

// Apple puts the SHA-256 of the app's raw nonce, as lowercase hex, in the token.
function identityToken(
  claims: JWTPayload = {},
  key: CryptoKey | Uint8Array = signingKey,
  alg = 'RS256',
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({
    iss: 'https://appleid.apple.com',
    aud: 'com.peaceandchaos.glow',
    sub: appleUserId,
    nonce: createHash('sha256').update(rawNonce).digest('hex'),
    iat: now,
    exp: now + 600,
    ...claims,
  })
    .setProtectedHeader({ alg, kid: 'local' })
    .sign(key);
}

test('an Apple identity token for this app and nonce gives its Apple user ID', async () => {
  expect(await appleUser(await identityToken(), rawNonce, appleKeys)).toBe(
    appleUserId,
  );
});

test.each<[string, () => Promise<string>]>([
  [
    'a signature from another key',
    async () =>
      identityToken({}, (await jose.generateKeyPair('RS256')).privateKey),
  ],
  [
    'a shared-secret signature',
    () => identityToken({}, new TextEncoder().encode('a'.repeat(32)), 'HS256'),
  ],
  ['another issuer', () => identityToken({ iss: 'https://example.com' })],
  ['another audience', () => identityToken({ aud: 'com.example.other' })],
  [
    'an expired token',
    () => identityToken({ exp: Math.floor(Date.now() / 1000) - 60 }),
  ],
  ['a token without an expiry', () => identityToken({ exp: undefined })],
  [
    'the nonce of another sign-in',
    () =>
      identityToken({
        nonce: createHash('sha256').update('another nonce').digest('hex'),
      }),
  ],
  ['a token without a nonce', () => identityToken({ nonce: undefined })],
])('Sign in with Apple rejects %s', async (_name, token) => {
  await expect(
    appleUser(await token(), rawNonce, appleKeys),
  ).rejects.toHaveProperty('status', 401);
});

test('an unreachable Apple key set is a server failure, not a rejected token', async () => {
  const timeout: JWTVerifyGetKey = () =>
    Promise.reject(new jose.errors.JWKSTimeout());
  await expect(
    appleUser(await identityToken(), rawNonce, timeout),
  ).rejects.toBeInstanceOf(jose.errors.JWKSTimeout);
});

test('the database keeps only a hash of each session token', async () => {
  const { database, postgres } = await testDatabase();
  try {
    const token = newSessionToken();
    const auth = await signedIn(database, [[token, appleUserId]]);
    const rows = await database.query(
      'SELECT row_to_json(sessions)::text AS data FROM sessions',
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].data).not.toContain(token);
    expect(rows.rows[0].data).toContain(
      createHash('sha256').update(token).digest('hex'),
    );
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    expect(await sessionOwner(headers, auth.allowlist, auth.sessions)).toBe(
      appleUserId,
    );
  } finally {
    await postgres.close();
  }
});

test.each([
  ['no credential', new Headers()],
  ['a device ID header', new Headers({ 'X-Device-Id': newSessionToken() })],
  ['a short token', new Headers({ Authorization: 'Bearer short' })],
  [
    'another scheme',
    new Headers({ Authorization: `Basic ${newSessionToken()}` }),
  ],
])('%s is rejected before any session lookup', async (_name, headers) => {
  const sessions = jest.fn(() => Promise.reject(new Error('Must not load')));
  await expect(
    sessionOwner(headers, appleUserId, sessions),
  ).rejects.toHaveProperty('status', 401);
  expect(sessions).not.toHaveBeenCalled();
});
