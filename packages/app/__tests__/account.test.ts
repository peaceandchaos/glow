import {
  appleAuth,
  type AppleRequestResponse,
} from '@invertase/react-native-apple-authentication';
import { TurboModuleRegistry } from 'react-native';
import * as Keychain from 'react-native-keychain';
import { restoreAccount, signInWithApple, signOut } from '../src/account';
import type { ClientResponse } from '../src/network/client';
import { nativeDrivers } from '../src/network/nativeDrivers';

// The native Keychain, as one in-memory item per service.
jest.mock('react-native-keychain', () => {
  const items = new Map<string, { username: string; password: string }>();
  return {
    ACCESSIBLE: {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly',
    },
    getGenericPassword: jest.fn(
      ({ service = '' }: { service?: string } = {}) => {
        const item = items.get(service);
        return Promise.resolve(item ? { ...item, service } : false);
      },
    ),
    setGenericPassword: jest.fn(
      (
        username: string,
        password: string,
        { service = '' }: { service?: string } = {},
      ) => {
        items.set(service, { username, password });
        return Promise.resolve({ service });
      },
    ),
    resetGenericPassword: jest.fn(
      ({ service = '' }: { service?: string } = {}) =>
        Promise.resolve(items.delete(service)),
    ),
  };
});
// The library's JavaScript and its native module, with the library's own
// constant values from lib/AppleAuthModule.js.
jest.mock('@invertase/react-native-apple-authentication', () => ({
  appleAuth: {
    Error: { UNKNOWN: '1000', CANCELED: '1001' },
    Operation: { IMPLICIT: 0, LOGIN: 1 },
    UserStatus: { LIKELY_REAL: 2 },
    State: { REVOKED: 0, AUTHORIZED: 1, NOT_FOUND: 2, TRANSFERRED: 3 },
    performRequest: jest.fn(),
    getCredentialStateForUser: jest.fn(),
  },
}));
jest.mock('../src/network/nativeDrivers', () => ({
  nativeDrivers: { fetch: jest.fn() },
}));
jest.mock('../src/config', () => ({ PROXY_BASE_URL: 'https://chat.example' }));

const service = 'personal-chat.session.v1';
const sessionUrl = 'https://chat.example/v1/session';
// 32 bytes of 0xfb, as the native CSPRNG returns them (base64) and as the raw
// nonce carries them (base64url).
const getEnforcing = TurboModuleRegistry.getEnforcing;
const random = {
  getConstants: () => ({}),
  getRandomBase64: () => `${'+/v7'.repeat(10)}+/s=`,
};
const rawNonce = `${'-_v7'.repeat(10)}-_s`;
const token = 't'.repeat(43);
const account = { appleUserId: 'apple-user', token };
const retry = 'Sign-in failed. Try again.';

function response(status: number, text = ''): ClientResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    text: () => Promise.resolve(text),
  };
}

function appleCredential(identityToken: string | null): AppleRequestResponse {
  return {
    nonce: rawNonce,
    user: 'apple-user',
    fullName: null,
    realUserStatus: appleAuth.UserStatus.LIKELY_REAL,
    authorizedScopes: [],
    identityToken,
    email: null,
    state: null,
    authorizationCode: 'authorization-code',
  };
}

function appleError(code: string): Error {
  return Object.assign(new Error(`Apple error ${code}`), { code });
}

const fetch = jest.mocked(nativeDrivers.fetch);
const performRequest = jest.mocked(appleAuth.performRequest);
const credentialState = jest.mocked(appleAuth.getCredentialStateForUser);

beforeEach(async () => {
  await Keychain.resetGenericPassword({ service });
  jest.clearAllMocks();
  fetch.mockReset();
  performRequest.mockReset();
  credentialState.mockReset();
  credentialState.mockResolvedValue(appleAuth.State.AUTHORIZED);
  jest
    .spyOn(TurboModuleRegistry, 'getEnforcing')
    .mockImplementation(name =>
      name === 'RNGetRandomValues' ? random : getEnforcing(name),
    );
});

async function savedAccount() {
  await Keychain.setGenericPassword(account.appleUserId, account.token, {
    service,
  });
}

describe('signing in', () => {
  test('sends the identity token with the raw nonce and keeps the returned session', async () => {
    performRequest.mockResolvedValueOnce(appleCredential('identity-token'));
    fetch.mockResolvedValueOnce(response(200, JSON.stringify({ token })));

    expect(await signInWithApple()).toEqual({ kind: 'signedIn', account });

    expect(performRequest.mock.calls).toEqual([
      [
        {
          requestedOperation: appleAuth.Operation.LOGIN,
          requestedScopes: [],
          nonce: rawNonce,
        },
      ],
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(sessionUrl);
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      signal: expect.any(AbortSignal),
    });
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    if (typeof init.body !== 'string')
      throw new Error('The sign-in request has no text body.');
    expect(JSON.parse(init.body)).toEqual({
      identityToken: 'identity-token',
      rawNonce,
    });
    expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
      'apple-user',
      token,
      {
        service,
        accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      },
    );
    expect(await restoreAccount()).toEqual(account);
  });

  test('a cancelled Apple sheet signs nothing in and shows no error', async () => {
    performRequest.mockRejectedValueOnce(appleError('1001'));

    expect(await signInWithApple()).toEqual({ kind: 'cancelled' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await restoreAccount()).toBeNull();
  });

  test('an Apple account the server does not allow is told so', async () => {
    performRequest.mockResolvedValueOnce(appleCredential('identity-token'));
    fetch.mockResolvedValueOnce(response(403, '{"error":"Not allowed."}'));

    expect(await signInWithApple()).toEqual({
      kind: 'failed',
      message: 'This Apple account is not allowed.',
    });
    expect(await restoreAccount()).toBeNull();
  });

  test.each([
    {
      name: 'Apple fails',
      apple: () => performRequest.mockRejectedValueOnce(appleError('1000')),
      server: () => undefined,
    },
    {
      name: 'Apple returns no identity token',
      apple: () => performRequest.mockResolvedValueOnce(appleCredential(null)),
      server: () => undefined,
    },
    {
      name: 'the server rejects the identity token',
      apple: () =>
        performRequest.mockResolvedValueOnce(appleCredential('identity-token')),
      server: () => fetch.mockResolvedValueOnce(response(401)),
    },
    {
      name: 'the server fails',
      apple: () =>
        performRequest.mockResolvedValueOnce(appleCredential('identity-token')),
      server: () => fetch.mockResolvedValueOnce(response(500)),
    },
    {
      name: 'the network fails',
      apple: () =>
        performRequest.mockResolvedValueOnce(appleCredential('identity-token')),
      server: () => fetch.mockRejectedValueOnce(new TypeError('Offline.')),
    },
    {
      name: 'the server answers without a token',
      apple: () =>
        performRequest.mockResolvedValueOnce(appleCredential('identity-token')),
      server: () => fetch.mockResolvedValueOnce(response(200, '{}')),
    },
    {
      name: 'the token cannot be sent as a bearer credential',
      apple: () =>
        performRequest.mockResolvedValueOnce(appleCredential('identity-token')),
      server: () =>
        fetch.mockResolvedValueOnce(response(200, '{"token":"a\\r\\nb"}')),
    },
  ])('when $name, sign-in fails with a retry message', async scenario => {
    scenario.apple();
    scenario.server();

    expect(await signInWithApple()).toEqual({ kind: 'failed', message: retry });
    expect(await restoreAccount()).toBeNull();
  });
});

describe('launch', () => {
  test('with nothing saved, the app is signed out and Apple is not asked', async () => {
    expect(await restoreAccount()).toBeNull();
    expect(credentialState).not.toHaveBeenCalled();
  });

  test.each(['AUTHORIZED', 'TRANSFERRED'] as const)(
    'keeps the saved session while Apple reports %s',
    async state => {
      await savedAccount();
      credentialState.mockResolvedValueOnce(appleAuth.State[state]);

      expect(await restoreAccount()).toEqual(account);
      expect(credentialState.mock.calls).toEqual([['apple-user']]);
    },
  );

  test('keeps the saved session when Apple cannot answer', async () => {
    await savedAccount();
    credentialState.mockRejectedValueOnce(appleError('1000'));

    expect(await restoreAccount()).toEqual(account);
  });

  test.each(['REVOKED', 'NOT_FOUND'] as const)(
    'signs out locally when Apple reports %s',
    async state => {
      await savedAccount();
      credentialState.mockResolvedValueOnce(appleAuth.State[state]);

      expect(await restoreAccount()).toBeNull();
      expect(await restoreAccount()).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe('signing out', () => {
  test('deletes the server session with the bearer token and forgets it', async () => {
    await savedAccount();
    fetch.mockResolvedValueOnce(response(204));

    await signOut(account);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(sessionUrl);
    expect(init).toMatchObject({
      method: 'DELETE',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(init.headers).toEqual({ Authorization: `Bearer ${token}` });
    expect(await restoreAccount()).toBeNull();
  });

  test('forgets the session even when the server cannot be reached', async () => {
    await savedAccount();
    fetch.mockRejectedValueOnce(new TypeError('Offline.'));

    await signOut(account);

    expect(await restoreAccount()).toBeNull();
  });
});
