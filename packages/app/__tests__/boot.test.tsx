import React from 'react';
import { Alert, Text, type AlertButton } from 'react-native';
import BootSplash from 'react-native-bootsplash';
import * as Keychain from 'react-native-keychain';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import App from '../App';

jest.mock('react-native-bootsplash', () => ({
  __esModule: true,
  default: { hide: jest.fn(() => Promise.resolve()) },
}));
jest.mock('react-native-keychain', () => ({
  getGenericPassword: jest.fn(),
  setGenericPassword: jest.fn(),
  ACCESSIBLE: {},
  STORAGE_TYPE: { AES_GCM: 'KeystoreAESGCM' },
}));
jest.mock('react-native-mmkv', () => ({
  createMMKV: () => {
    const values = new Map<string, string>();
    return {
      getString: (key: string) => values.get(key),
      getAllKeys: () => [...values.keys()],
      set: (key: string, value: string) => values.set(key, value),
      remove: (key: string) => values.delete(key),
    };
  },
}));
jest.mock('../src/device', () => ({
  ...jest.requireActual('../src/device'),
  secureId: () => require('node:crypto').randomUUID(),
}));
jest.mock('../src/network/nativeDrivers', () => ({ nativeDrivers: {} }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  initialWindowMetrics: null,
}));
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../src/screens/RootDrawer', () => {
  const { useChatStore } = require('../src/state/chatStore');
  const { Text: MockText } = require('react-native');
  return {
    RootDrawer: () => (
      <MockText>
        {useChatStore((state: { chatId: string }) => state.chatId)}
      </MockText>
    ),
  };
});

const deviceId = 'a'.repeat(43);

test('a failed start hides the splash and offers Retry, and Retry opens the saved chats', async () => {
  const keychain = jest.mocked(Keychain.getGenericPassword);
  keychain
    .mockRejectedValueOnce(new Error('The keychain is locked.'))
    .mockResolvedValue({
      service: 'personal-chat.device-id.v1',
      username: 'device',
      password: deviceId,
      storage: Keychain.STORAGE_TYPE.AES_GCM,
    });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

  const rendered = React.createRef<ReactTestRenderer>();
  await act(async () => {
    rendered.current = create(<App />);
  });
  const renderer = rendered.current;
  if (!renderer) throw new Error('The test renderer was not created.');
  expect(BootSplash.hide).toHaveBeenCalled();
  expect(alert).toHaveBeenCalledTimes(1);
  const [title, message, buttons] = alert.mock.calls[0];
  expect(title).toBe('Something went wrong');
  expect(message).toBe('Your chats could not be opened.');
  expect(renderer.root.findAllByType(Text)).toEqual([]);
  const retry = buttons?.find((button: AlertButton) => button.text === 'Retry');

  await act(async () => {
    retry?.onPress?.();
  });
  expect(keychain).toHaveBeenCalledTimes(2);
  expect(alert).toHaveBeenCalledTimes(1);
  const shown = renderer.root.findByType(Text).props.children;
  expect(shown).toMatch(/^[0-9a-f-]{36}$/u);
});
