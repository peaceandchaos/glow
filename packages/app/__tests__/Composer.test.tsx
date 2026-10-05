import React from 'react';
import { TextInput, View } from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createStore } from 'zustand/vanilla';
import { Composer, type SendResult } from '../src/components/Composer';
import { ChatStoreContext } from '../src/state/chatStore';
import type { ChatViewState } from '../src/state/chatView';

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  Easing: { inOut: () => undefined, ease: undefined },
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
    return null;
  },
}));
jest.mock('../src/components/Glass', () => ({
  Glass: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../src/components/Icon', () => ({ Icon: () => null }));

function chatStore(draftsOnDisk: Record<string, string> = {}) {
  const saveDraftAfterPause = jest.fn<void, [string, string]>();
  const store = createStore<ChatViewState>()(() => ({
    chatId: 'chat',
    messages: [],
    isStreaming: false,
    recents: [],
    send: () => null,
    stop: () => undefined,
    newChat: () => undefined,
    openChat: () => undefined,
    loadOlder: () => undefined,
    draftText: chatId => draftsOnDisk[chatId] ?? '',
    saveDraftAfterPause,
    saveDraftsNow: () => undefined,
  }));
  const wrap = (element: React.ReactElement) => (
    <ChatStoreContext.Provider value={store}>
      {element}
    </ChatStoreContext.Provider>
  );
  return { saveDraftAfterPause, wrap };
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
  const send = renderer.root.find(
    node => node.props.hitSlop === 6 && node.props.disabled === false,
  );
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
      renderer.root
        .find(node => node.props.hitSlop === 6 && node.props.disabled === false)
        .props.onPress();
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
