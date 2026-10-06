import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { createHash, randomUUID } from 'node:crypto';
import { decodeJson, sessionResponseSchema } from '../../../shared/contracts';
import { handleRequest, SocketConnection, type ApiServices } from '../src/api';
import {
  appleUser,
  newSessionToken,
  sessionOwner,
  SessionStore,
} from '../src/auth';
import type { Database } from '../src/database';
import { JobRepository } from '../src/jobs';
import { testDatabase } from './database';
import { signedIn } from './sessions';

jest.setTimeout(30_000);

const appleUserId = 'apple-user-1';
const rawNonce = 'raw-nonce-from-the-app';
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
    expect(await sessionOwner(headers, auth)).toBe(appleUserId);
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
    sessionOwner(headers, { allowedAppleUserIds: appleUserId, sessions }),
  ).rejects.toHaveProperty('status', 401);
  expect(sessions).not.toHaveBeenCalled();
});

type Server = {
  services: ApiServices;
  database: Database;
  close: () => Promise<void>;
};

async function startServer(allowedAppleUserIds = appleUserId): Promise<Server> {
  const { database, postgres } = await testDatabase();
  const jobs = new JobRepository(database);
  return {
    services: {
      allowedAppleUserIds,
      appleKeys,
      sessions: () => Promise.resolve(new SessionStore(database)),
      jobs: () => Promise.resolve(jobs),
      dispatch: () => Promise.reject(new Error('Must not dispatch')),
      rank: () => Promise.resolve([]),
    },
    database,
    close: () => postgres.close(),
  };
}

async function signIn(server: Server, nonce = rawNonce): Promise<Response> {
  return handleRequest(
    new Request('https://fixture.example/v1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identityToken: await identityToken(),
        rawNonce: nonce,
      }),
    }),
    server.services,
  );
}

async function sessionToken(server: Server): Promise<string> {
  const response = await signIn(server);
  expect(response.status).toBe(200);
  return decodeJson(sessionResponseSchema, await response.text()).token;
}

function deleteChat(server: Server, chatId: string, authorization?: string) {
  return handleRequest(
    new Request(`https://fixture.example/v1/chats/${chatId}`, {
      method: 'DELETE',
      headers: authorization ? { Authorization: authorization } : {},
    }),
    server.services,
  );
}

async function sessionCount(server: Server): Promise<number> {
  const { rows } = await server.database.query(
    'SELECT count(*)::text AS data FROM sessions',
  );
  return Number(rows[0].data);
}

test('a session from Sign in with Apple authorizes requests as that Apple user', async () => {
  const server = await startServer();
  try {
    const response = await signIn(server);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const { token } = decodeJson(sessionResponseSchema, await response.text());
    const chatId = randomUUID();
    const deleted = await deleteChat(server, chatId, `Bearer ${token}`);
    expect(deleted.status).toBe(204);
    const { rows } = await server.database.query(
      'SELECT owner AS data FROM deleted_chats WHERE chat_id = $1',
      [chatId],
    );
    expect(rows.map(row => row.data)).toEqual([appleUserId]);
  } finally {
    await server.close();
  }
});

test('a refused identity token gets 401 and no session', async () => {
  const server = await startServer();
  try {
    expect((await signIn(server, 'another nonce')).status).toBe(401);
    expect(await sessionCount(server)).toBe(0);
  } finally {
    await server.close();
  }
});

test('an Apple user who is not on the allowlist gets 403, and the log names them', async () => {
  const server = await startServer('apple-user-not-allowed');
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const response = await signIn(server);
    expect(response.status).toBe(403);
    expect(warn.mock.calls).toEqual([
      [
        `sign-in refused: ALLOWED_APPLE_USER_IDS does not list Apple user ${appleUserId}`,
      ],
    ]);
    expect(await sessionCount(server)).toBe(0);
  } finally {
    warn.mockRestore();
    await server.close();
  }
});

test.each([
  ['no credential', undefined],
  ['a malformed token', 'Bearer not-a-session-token'],
  ['a token the server never issued', `Bearer ${newSessionToken()}`],
])('a request with %s gets 401', async (_name, authorization) => {
  const server = await startServer();
  try {
    expect((await deleteChat(server, randomUUID(), authorization)).status).toBe(
      401,
    );
    const health = await handleRequest(
      new Request('https://fixture.example/v1/health', {
        headers: authorization ? { Authorization: authorization } : {},
      }),
      server.services,
    );
    expect(health.status).toBe(401);
  } finally {
    await server.close();
  }
});

test('sign-out revokes only the session that signs out', async () => {
  const server = await startServer();
  try {
    const leaving = await sessionToken(server);
    const staying = await sessionToken(server);
    const signOut = await handleRequest(
      new Request('https://fixture.example/v1/session', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${leaving}` },
      }),
      server.services,
    );
    expect(signOut.status).toBe(204);
    expect(
      (await deleteChat(server, randomUUID(), `Bearer ${leaving}`)).status,
    ).toBe(401);
    expect(
      (await deleteChat(server, randomUUID(), `Bearer ${staying}`)).status,
    ).toBe(204);
  } finally {
    await server.close();
  }
});

test('removing a user from the allowlist locks out their existing sessions', async () => {
  const server = await startServer();
  try {
    const token = await sessionToken(server);
    server.services.allowedAppleUserIds = '';
    expect(
      (await deleteChat(server, randomUUID(), `Bearer ${token}`)).status,
    ).toBe(401);
  } finally {
    await server.close();
  }
});

test.each([
  ['no credential', undefined],
  ['a malformed token', 'Bearer not-a-session-token'],
  ['a token the server never issued', `Bearer ${newSessionToken()}`],
])(
  'the socket closes for %s without running the frame',
  async (_name, authorization) => {
    const server = await startServer();
    const jobs = jest.spyOn(server.services, 'jobs');
    const closed: number[] = [];
    const sent: string[] = [];
    try {
      const connection = new SocketConnection(
        new Headers(authorization ? { Authorization: authorization } : {}),
        () => server.services,
        {
          isOpen: () => true,
          send: text => sent.push(text),
          close: code => closed.push(code),
        },
      );
      await connection.message(() =>
        JSON.stringify({ kind: 'attach', attemptId: randomUUID(), after: 0 }),
      );
      expect(closed).toEqual([1008]);
      expect(sent).toEqual([]);
      expect(jobs).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  },
);

test('the socket admits a signed-in user until the user leaves the allowlist', async () => {
  const server = await startServer();
  const closed: number[] = [];
  const sent: string[] = [];
  try {
    const token = await sessionToken(server);
    const connection = new SocketConnection(
      new Headers({ Authorization: `Bearer ${token}` }),
      () => server.services,
      {
        isOpen: () => true,
        send: text => sent.push(text),
        close: code => closed.push(code),
      },
    );
    const frame = () =>
      JSON.stringify({ kind: 'attach', attemptId: randomUUID(), after: 0 });
    await connection.message(frame);
    expect(closed).toEqual([]);
    expect(sent).toHaveLength(1);
    server.services.allowedAppleUserIds = '';
    await connection.message(frame);
    expect(closed).toEqual([1008]);
    expect(sent).toHaveLength(1);
  } finally {
    await server.close();
  }
});
