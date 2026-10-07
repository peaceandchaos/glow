import React from 'react';
import { Alert, TextInput, View } from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createStore } from 'zustand/vanilla';
import { bakedCatalog } from '../../../shared/catalog';
import type { LevelKey, Picker } from '../../../shared/contracts';
import { Composer, type SendResult } from '../src/components/Composer';
import { ChatStoreContext } from '../src/state/chatStore';
import type { ChatViewState } from '../src/state/chatView';

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  Easing: { inOut: () => undefined, ease: undefined },
  cubicBezier: () => undefined,
  useReducedMotion: () => false,
  useAnimatedStyle: () => ({}),
  withTiming: () => 0,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('react-native-nitro-image', () => ({ NitroImage: () => null }));
jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
}));
let mockPickPhotos: () => Promise<void>;
jest.mock('../src/components/AttachmentMenu', () => ({
  AttachmentMenu: ({ onPickPhotos }: { onPickPhotos: () => Promise<void> }) => {
    mockPickPhotos = onPickPhotos;
    const { View: MenuButton } = require('react-native');
    return <MenuButton accessibilityLabel="Attach" />;
  },
}));
let mockRecognizer: {
  onText: (text: string) => void;
  onEnd: () => void;
} | null = null;
const mockDictation = {
  start: jest.fn(async () => undefined),
  stop: jest.fn(),
  listen: (onText: (text: string) => void, onEnd: () => void) => {
    mockRecognizer = { onText, onEnd };
    return () => {
      mockRecognizer = null;
    };
  },
};
jest.mock('../src/dictation', () => ({
  get dictation() {
    return mockDictation;
  },
}));
jest.mock('../src/components/Glass', () => ({
  Glass: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../src/components/Icon', () => ({ Icon: () => null }));
jest.mock('../src/components/GaugeDial', () => ({ GaugeDial: () => null }));
jest.mock('zeego/context-menu', () => {
  const { View: MenuItem } = require('react-native');
  const passThrough = ({ children }: { children: React.ReactNode }) => children;
  const hidden = () => null;
  return {
    Root: passThrough,
    Trigger: passThrough,
    Content: passThrough,
    Label: hidden,
    CheckboxItem: ({
      value,
      onValueChange,
    }: {
      value: string;
      onValueChange: () => void;
    }) => (
      <MenuItem testID="level" value={value} onValueChange={onValueChange} />
    ),
    ItemIndicator: hidden,
    ItemTitle: hidden,
  };
});

function chatStore(
  draftsOnDisk: Record<string, string> = {},
  picker: Picker = 'kimi',
) {
  const saveDraftAfterPause = jest.fn<void, [string, string]>();
  const setLevel = jest.fn<void, [LevelKey]>(level =>
    store.setState({ level }),
  );
  const store = createStore<ChatViewState>()(() => ({
    chatId: 'chat',
    picker,
    level: undefined,
    catalog: bakedCatalog,
    messages: [],
    isStreaming: false,
    recents: [],
    send: () => null,
    stop: () => undefined,
    setPicker: () => undefined,
    setLevel,
    newChat: () => undefined,
    openChat: () => undefined,
    loadOlder: () => undefined,
    draftText: chatId => draftsOnDisk[chatId] ?? '',
    saveDraftAfterPause,
    saveDraftsNow: () => undefined,
    receiveCatalog: () => undefined,
  }));
  const wrap = (element: React.ReactElement) => (
    <ChatStoreContext.Provider value={store}>
      {element}
    </ChatStoreContext.Provider>
  );
  return { saveDraftAfterPause, setLevel, store, wrap };
}

const buttons = (renderer: ReactTestRenderer, label: string) =>
  renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
function button(renderer: ReactTestRenderer, label: string) {
  const [found] = buttons(renderer, label);
  if (!found) throw new Error(`No ${label} button.`);
  return found;
}

function renderComposer(result: SendResult) {
  const onSubmit = jest.fn(() => result);
  const { wrap } = chatStore();
  const rendered = React.createRef<ReactTestRenderer>();
  act(() => {
    rendered.current = create(
      wrap(
        <Composer
          chatId="chat"
          onSubmit={onSubmit}
          onStop={() => undefined}
          streaming={false}
          composerRef={React.createRef<View>()}
          onLayout={() => undefined}
        />,
      ),
    );
  });
  const renderer = rendered.current;
  if (!renderer) throw new Error('The test renderer was not created.');
  const input = () => renderer.root.findByType(TextInput);
  act(() => {
    input().props.onChangeText('Draft');
  });
  const send = button(renderer, 'Send');
  expect(send.props.disabled).toBe(false);
  act(() => {
    send.props.onPress();
  });
  return { onSubmit, text: input().props.value };
}

test('the composer keeps its text when the message was not saved', () => {
  const { onSubmit, text } = renderComposer('unsaved');
  expect(onSubmit).toHaveBeenCalledWith('Draft', []);
  expect(text).toBe('Draft');
});

test('the composer clears its text once the message is saved', () => {
  expect(renderComposer('saved').text).toBe('');
});

test('each chat keeps its own draft text and photos, and switching back restores them', async () => {
  const onSubmit = jest.fn((): SendResult => 'saved');
  const { wrap } = chatStore();
  const composer = (chatId: string) =>
    wrap(
      <Composer
        chatId={chatId}
        onSubmit={onSubmit}
        onStop={() => undefined}
        streaming={false}
        composerRef={React.createRef<View>()}
        onLayout={() => undefined}
      />,
    );
  const rendered = React.createRef<ReactTestRenderer>();
  act(() => {
    rendered.current = create(composer('a'));
  });
  const renderer = rendered.current;
  if (!renderer) throw new Error('The test renderer was not created.');
  const input = () => renderer.root.findByType(TextInput);
  const open = (chatId: string) => act(() => renderer.update(composer(chatId)));
  const send = () =>
    act(() => {
      const sendButton = button(renderer, 'Send');
      expect(sendButton.props.disabled).toBe(false);
      sendButton.props.onPress();
    });
  const photo = {
    uri: 'file:///tmp/a.jpg',
    dataUrl: 'data:image/jpeg;base64,AAAA',
  };

  act(() => {
    input().props.onChangeText('Draft A');
  });
  jest.mocked(launchImageLibrary).mockResolvedValue({
    assets: [{ uri: photo.uri, type: 'image/jpeg', base64: 'AAAA' }],
  });
  await act(() => mockPickPhotos());

  open('b');
  expect(input().props.value).toBe('');
  act(() => {
    input().props.onChangeText('Draft B');
  });

  open('a');
  expect(input().props.value).toBe('Draft A');
  send();
  expect(onSubmit).toHaveBeenLastCalledWith('Draft A', [photo]);
  expect(input().props.value).toBe('');

  open('b');
  expect(input().props.value).toBe('Draft B');
  send();
  expect(onSubmit).toHaveBeenLastCalledWith('Draft B', []);
});

test('each chat opens with the draft text saved before the relaunch, and every text change goes to the store', () => {
  const { saveDraftAfterPause, wrap } = chatStore({ a: 'Saved A' });
  const composer = (chatId: string) =>
    wrap(
      <Composer
        chatId={chatId}
        onSubmit={() => 'saved'}
        onStop={() => undefined}
        streaming={false}
        composerRef={React.createRef<View>()}
        onLayout={() => undefined}
      />,
    );
  const rendered = React.createRef<ReactTestRenderer>();
  act(() => {
    rendered.current = create(composer('a'));
  });
  const renderer = rendered.current;
  if (!renderer) throw new Error('The test renderer was not created.');
  const input = () => renderer.root.findByType(TextInput);
  expect(input().props.value).toBe('Saved A');

  act(() => renderer.update(composer('b')));
  expect(input().props.value).toBe('');
  act(() => {
    input().props.onChangeText('Draft B');
  });
  expect(saveDraftAfterPause).toHaveBeenLastCalledWith('b', 'Draft B');
  act(() => {
    input().props.onChangeText('');
  });
  expect(saveDraftAfterPause).toHaveBeenLastCalledWith('b', '');
});

function mountComposer(picker: Picker = 'gpt-6.1-sol') {
  const chat = chatStore({}, picker);
  const rendered = React.createRef<ReactTestRenderer>();
  act(() => {
    rendered.current = create(
      chat.wrap(
        <Composer
          chatId="chat"
          onSubmit={() => 'saved'}
          onStop={() => undefined}
          streaming={false}
          composerRef={React.createRef<View>()}
          onLayout={() => undefined}
        />,
      ),
    );
  });
  const renderer = rendered.current;
  if (!renderer) throw new Error('The test renderer was not created.');
  return {
    ...chat,
    renderer,
    shows: (label: string) => buttons(renderer, label).length > 0,
    input: () => renderer.root.findByType(TextInput),
  };
}

test('the bar holds the plus, the text field, the effort gauge, the microphone and the send button, in that order', () => {
  const { renderer } = mountComposer();
  const order = renderer.root
    .findAll(
      node =>
        typeof node.type === 'string' &&
        (node.props.accessibilityLabel || node.props.placeholder),
    )
    .map(node => node.props.accessibilityLabel ?? node.props.placeholder);
  expect(order).toEqual([
    'Attach',
    'Ask anything',
    'Reasoning effort',
    'Dictate',
    'Send',
  ]);
});

test('a tap on the gauge steps the chat’s level up one, wraps to the lowest after the highest, and saves each pick', () => {
  const { renderer, setLevel } = mountComposer('gpt-6.1-sol');
  const gauge = () => button(renderer, 'Reasoning effort');
  expect(gauge().props.accessibilityHint).toBe('Double-tap to increase');
  const shown = [gauge().props.accessibilityValue.text];
  for (let tap = 0; tap < 5; tap++) {
    act(() => {
      gauge().props.onPress();
    });
    shown.push(gauge().props.accessibilityValue.text);
  }
  expect(shown).toEqual(['Low', 'Medium', 'High', 'Extra high', 'Max', 'Low']);
  expect(setLevel.mock.calls).toEqual([
    ['medium'],
    ['high'],
    ['xhigh'],
    ['max'],
    ['low'],
  ]);
});

test('the gauge is hidden under Auto and for a model with no levels', () => {
  expect(mountComposer('auto').shows('Reasoning effort')).toBe(false);

  const kimi = mountComposer('kimi');
  expect(kimi.shows('Reasoning effort')).toBe(true);
  const [deepseek, kimiModel, ...rest] = bakedCatalog.models;
  act(() =>
    kimi.store.setState({
      catalog: {
        auto: true,
        models: [deepseek, { ...kimiModel, levels: [] }, ...rest],
      },
    }),
  );
  expect(kimi.shows('Reasoning effort')).toBe(false);
});

test('dictation adds its transcript after the draft as it arrives, shows the recording state, and a second tap stops it', async () => {
  mockDictation.start.mockClear();
  mockDictation.stop.mockClear();
  const { renderer, input } = mountComposer();
  act(() => {
    input().props.onChangeText('Draft');
  });
  await act(async () => button(renderer, 'Dictate').props.onPress());
  expect(mockDictation.start).toHaveBeenCalledTimes(1);
  expect(input().props.placeholder).toBe('Listening…');
  expect(button(renderer, 'Stop dictation').props.accessibilityState).toEqual({
    selected: true,
  });

  act(() => mockRecognizer?.onText('hello'));
  expect(input().props.value).toBe('Draft hello');
  act(() => mockRecognizer?.onText('hello world.'));
  expect(input().props.value).toBe('Draft hello world.');

  act(() => {
    button(renderer, 'Stop dictation').props.onPress();
  });
  expect(mockDictation.stop).toHaveBeenCalledTimes(1);
  act(() => mockRecognizer?.onEnd());
  expect(mockRecognizer).toBeNull();
  expect(input().props.placeholder).toBe('Ask anything');
  expect(input().props.value).toBe('Draft hello world.');
  expect(button(renderer, 'Dictate').props.accessibilityState).toEqual({
    selected: false,
  });
});

function nativeRejection(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

test.each([
  [
    'a permission refusal',
    nativeRejection('denied', 'NATIVE DETAIL'),
    'Allow microphone and speech access in Settings.',
  ],
  [
    'a missing microphone',
    nativeRejection('unavailable', 'No microphone is available right now.'),
    'No microphone is available right now.',
  ],
  [
    'any other native failure',
    nativeRejection('unavailable', 'NATIVE DETAIL'),
    'Dictation stopped. Try again.',
  ],
  [
    'a rejection that is not an Error',
    'NATIVE DETAIL',
    'Dictation stopped. Try again.',
  ],
])(
  '%s shows a fixed sentence, never the native text, and leaves the microphone ready',
  async (_case, rejection, sentence) => {
    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation(() => undefined);
    mockDictation.start.mockRejectedValueOnce(rejection);
    const { renderer, input } = mountComposer();
    await act(async () => button(renderer, 'Dictate').props.onPress());
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith('Dictation is unavailable', sentence);
    expect(JSON.stringify(alert.mock.calls)).not.toContain('NATIVE DETAIL');
    expect(mockRecognizer).toBeNull();
    expect(input().props.placeholder).toBe('Ask anything');
    alert.mockRestore();
  },
);

test('a long press lists the levels with the chat’s level checked, and a pick saves it', () => {
  const { renderer, setLevel } = mountComposer('gpt-6.1-sol');
  const items = () =>
    renderer.root.findAll(
      node => typeof node.type === 'string' && node.props.testID === 'level',
    );
  expect(items().map(item => item.props.value)).toEqual([
    'on',
    'off',
    'off',
    'off',
    'off',
  ]);
  act(() => {
    items()[2].props.onValueChange();
  });
  expect(setLevel.mock.calls).toEqual([['high']]);
  expect(items().map(item => item.props.value)).toEqual([
    'off',
    'off',
    'on',
    'off',
    'off',
  ]);
});
