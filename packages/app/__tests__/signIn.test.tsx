import React from 'react';
import {
  appleAuth,
  type AppleRequestResponse,
} from '@invertase/react-native-apple-authentication';
import {
  Alert,
  AppState,
  Text,
  TurboModuleRegistry,
  type AlertButton,
} from 'react-native';
import * as Keychain from 'react-native-keychain';
import { createMMKV } from 'react-native-mmkv';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import App from '../App';
import type { ClientResponse, ClientSocket } from '../src/network/client';
import { nativeDrivers } from '../src/network/nativeDrivers';
import { stopAppSession } from '../src/state/appSession';

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
jest.mock('react-native-bootsplash', () => ({
  __esModule: true,
  default: {
    hide: jest.fn(() => Promise.resolve()),
    HideOnDraw: () => null,
  },
}));
jest.mock('react-native-mmkv', () => ({
  createMMKV: jest.fn(() => {
    const values = new Map<string, string>();
    return {
      getString: (key: string) => values.get(key),
      getAllKeys: () => [...values.keys()],
      set: (key: string, value: string) => values.set(key, value),
      remove: (key: string) => values.delete(key),
    };
  }),
}));
jest.mock('../src/network/nativeDrivers', () => ({
  nativeDrivers: { fetch: jest.fn(), socket: jest.fn(), decoder: jest.fn() },
}));
jest.mock('../src/config', () => ({ PROXY_BASE_URL: 'https://chat.example' }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  initialWindowMetrics: null,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@legendapp/list/react-native', () => ({ LegendList: () => null }));
jest.mock('../src/components/Glass', () => ({
  Glass: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../src/components/Icon', () => ({ Icon: () => null }));
jest.mock('../src/screens/RootDrawer', () => {
  const { Pressable: MockPressable, Text: MockText } =
    jest.requireActual('react-native');
  const { RecentsScreen } = jest.requireActual('../src/screens/RecentsScreen');
  const { useChatStore } = jest.requireActual('../src/state/chatStore');
  return {
    RootDrawer: () => {
      const send = useChatStore(
        (state: { send: (text: string) => void }) => state.send,
      );
      return (
        <>
          <MockText>Chats</MockText>
          <MockPressable
            accessibilityLabel="Send Hello"
            onPress={() => send('Hello')}
          />
          <RecentsScreen
            onNewChat={() => undefined}
            onOpenChat={() => undefined}
          />
        </>
      );
    },
  };
});

const service = 'personal-chat.session.v1';
const sessionUrl = 'https://chat.example/v1/session';
const signInLabel = 'Sign in with Apple';

const fetch = jest.mocked(nativeDrivers.fetch);
const socket = jest.mocked(nativeDrivers.socket);
const performRequest = jest.mocked(appleAuth.performRequest);
const credentialState = jest.mocked(appleAuth.getCredentialStateForUser);
const getEnforcing = TurboModuleRegistry.getEnforcing;
const random = {
  getConstants: () => ({}),
  getRandomBase64: (bytes: number) =>
    require('node:crypto').randomBytes(bytes).toString('base64'),
};

function response(status: number, text = ''): ClientResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    text: () => Promise.resolve(text),
  };
}

function appleCredential(): AppleRequestResponse {
  return {
    nonce: 'raw-nonce',
    user: 'apple-user',
    fullName: null,
    realUserStatus: appleAuth.UserStatus.LIKELY_REAL,
    authorizedScopes: [],
    identityToken: 'identity-token',
    email: null,
    state: null,
    authorizationCode: 'authorization-code',
  };
}

class QuietSocket implements ClientSocket {
  readyState = 'CONNECTING';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((error: string) => void) | null = null;
  closedWith: number | null = null;
  constructor() {
    setTimeout(() => {
      this.readyState = 'OPEN';
      this.onopen?.();
    }, 0);
  }
  send(): void {}
  close(code = 1000): void {
    this.closedWith = code;
    this.readyState = 'CLOSED';
    this.onclose?.({ code });
  }
}
let sockets: QuietSocket[] = [];

beforeEach(async () => {
  await Keychain.resetGenericPassword({ service });
  jest.clearAllMocks();
  fetch.mockReset();
  performRequest.mockReset();
  credentialState.mockReset();
  credentialState.mockResolvedValue(appleAuth.State.AUTHORIZED);
  sockets = [];
  socket.mockImplementation(() => {
    const opened = new QuietSocket();
    sockets.push(opened);
    return opened;
  });
  foregroundedListeners = 0;
  jest
    .spyOn(TurboModuleRegistry, 'getEnforcing')
    .mockImplementation(name =>
      name === 'RNGetRandomValues' ? random : getEnforcing(name),
    );
});

let mounted: ReactTestRenderer | null = null;

afterEach(async () => {
  await act(async () => mounted?.unmount());
  mounted = null;
  await stopAppSession();
  jest.restoreAllMocks();
});

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

async function launch() {
  const rendered = React.createRef<ReactTestRenderer>();
  await act(async () => {
    rendered.current = create(<App />);
  });
  await settle();
  const renderer = rendered.current;
  if (!renderer) throw new Error('The test renderer was not created.');
  mounted = renderer;
  const control = (label: string): ReactTestInstance => {
    const [found] = renderer.root.findAll(
      node =>
        node.props.accessibilityLabel === label &&
        typeof node.props.onPress === 'function',
    );
    if (!found) throw new Error(`No control is labelled ${label}.`);
    return found;
  };
  return {
    texts: () =>
      renderer.root
        .findAllByType(Text)
        .map(text => text.props.children)
        .filter(child => typeof child === 'string'),
    control,
    press: async (label: string) => {
      await act(async () => {
        control(label).props.onPress();
      });
      await settle();
    },
  };
}

let foregroundedListeners = 0;
async function enterForeground() {
  const calls = jest.mocked(AppState.addEventListener).mock.calls;
  const added = calls.slice(foregroundedListeners);
  foregroundedListeners = calls.length;
  await act(async () => {
    for (const [event, listener] of added)
      if (event === 'change') listener('active');
  });
}

async function savedAccount() {
  await Keychain.setGenericPassword('apple-user', 'session-token', {
    service,
  });
}

test('signed out, the app shows only the sign-in button and starts no chat session', async () => {
  const app = await launch();

  expect(app.texts()).toEqual([signInLabel]);
  expect(app.control(signInLabel).props.accessibilityState).toEqual({
    disabled: false,
    busy: false,
  });
  expect(createMMKV).not.toHaveBeenCalled();
  expect(credentialState).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test('the sign-in screen goes from request to failure, retries, and opens the chats on success', async () => {
  let finishApple: (credential: AppleRequestResponse) => void = () => {
    throw new Error('Apple was not asked.');
  };
  const app = await launch();

  performRequest.mockReturnValueOnce(
    new Promise(resolve => {
      finishApple = resolve;
    }),
  );
  await app.press(signInLabel);
  expect(app.control(signInLabel).props.disabled).toBe(true);
  expect(app.control(signInLabel).props.accessibilityState).toEqual({
    disabled: true,
    busy: true,
  });
  fetch.mockResolvedValueOnce(response(500));
  await act(async () => finishApple(appleCredential()));
  await settle();
  expect(app.texts()).toEqual(['Sign-in failed. Try again.', signInLabel]);
  expect(app.control(signInLabel).props.accessibilityState).toEqual({
    disabled: false,
    busy: false,
  });

  performRequest.mockRejectedValueOnce(
    Object.assign(new Error('Canceled.'), { code: '1001' }),
  );
  await app.press(signInLabel);
  expect(app.texts()).toEqual([signInLabel]);

  performRequest.mockResolvedValueOnce(appleCredential());
  fetch.mockResolvedValueOnce(response(403));
  await app.press(signInLabel);
  expect(app.texts()).toEqual([
    'This Apple account is not allowed.',
    signInLabel,
  ]);
  expect(createMMKV).not.toHaveBeenCalled();

  performRequest.mockResolvedValueOnce(appleCredential());
  fetch.mockResolvedValueOnce(
    response(200, JSON.stringify({ token: 't'.repeat(43) })),
  );
  await app.press(signInLabel);
  expect(app.texts()).toContain('Chats');
  expect(app.texts()).not.toContain(signInLabel);
  expect(fetch.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
    [sessionUrl, 'POST'],
    [sessionUrl, 'POST'],
    [sessionUrl, 'POST'],
  ]);
});

test('a launch with a session Apple has revoked shows the sign-in screen and opens no chats', async () => {
  await savedAccount();
  credentialState.mockResolvedValueOnce(appleAuth.State.REVOKED);

  const app = await launch();

  expect(credentialState.mock.calls).toEqual([['apple-user']]);
  expect(app.texts()).toEqual([signInLabel]);
  expect(createMMKV).not.toHaveBeenCalled();
  expect(await Keychain.getGenericPassword({ service })).toBe(false);
});

test('a launch with an authorized session opens the chats, whose socket carries the bearer token', async () => {
  await savedAccount();

  const app = await launch();
  expect(app.texts()).toContain('Chats');
  expect(app.texts()).not.toContain(signInLabel);
  await enterForeground();

  await app.press('Send Hello');
  expect(socket.mock.calls).toEqual([
    [
      'wss://chat.example/v1/responses',
      { Authorization: 'Bearer session-token' },
    ],
  ]);
});

test('signing out from the Recents settings button asks first, deletes the session, closes the socket, and returns to sign-in', async () => {
  await savedAccount();
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const app = await launch();
  await enterForeground();
  await app.press('Send Hello');
  expect(sockets.map(opened => opened.readyState)).toEqual(['OPEN']);

  await app.press('Settings');
  expect(alert).toHaveBeenCalledTimes(1);
  const [title, , buttons] = alert.mock.calls[0];
  expect(title).toBe('Sign out?');
  const button = (text: string): AlertButton => {
    const found = buttons?.find(candidate => candidate.text === text);
    if (!found) throw new Error(`The alert has no ${text} button.`);
    return found;
  };
  expect(button('Cancel').style).toBe('cancel');
  expect(button('Sign Out').style).toBe('destructive');

  await act(async () => button('Cancel').onPress?.());
  expect(fetch).not.toHaveBeenCalled();
  expect(app.texts()).toContain('Chats');

  fetch.mockResolvedValueOnce(response(204));
  await act(async () => button('Sign Out').onPress?.());
  await settle();

  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe(sessionUrl);
  expect(fetch.mock.calls[0][1]).toMatchObject({
    method: 'DELETE',
    headers: { Authorization: 'Bearer session-token' },
  });
  expect(await Keychain.getGenericPassword({ service })).toBe(false);
  expect(sockets.map(opened => opened.closedWith)).toEqual([1000]);
  expect(app.texts()).toEqual([signInLabel]);
});

test('after sign-out, the next sign-in starts chats that use its own token', async () => {
  const nextToken = 'n'.repeat(43);
  await savedAccount();
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const app = await launch();
  await enterForeground();
  await app.press('Settings');
  const signOutButton = alert.mock.calls[0][2]?.find(
    button => button.text === 'Sign Out',
  );
  fetch.mockResolvedValueOnce(response(204));
  await act(async () => signOutButton?.onPress?.());
  await settle();
  expect(app.texts()).toEqual([signInLabel]);

  performRequest.mockResolvedValueOnce(appleCredential());
  fetch.mockResolvedValueOnce(
    response(200, JSON.stringify({ token: nextToken })),
  );
  await app.press(signInLabel);
  await enterForeground();
  await app.press('Send Hello');

  expect(socket.mock.calls.at(-1)?.[1]).toEqual({
    Authorization: `Bearer ${nextToken}`,
  });
});
