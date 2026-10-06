import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createStore } from 'zustand/vanilla';
import { RootDrawer } from '../src/screens/RootDrawer';
import { ChatStoreContext } from '../src/state/chatStore';
import type { ChatViewState } from '../src/state/chatView';

jest.mock('react-native-pager-view', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: ({ children, ...props }: { children: React.ReactNode }) => (
      <View testID="pager" {...props}>
        {children}
      </View>
    ),
  };
});
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardController: { dismiss: () => undefined },
  KeyboardStickyView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  cubicBezier: () => undefined,
  useReducedMotion: () => false,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('react-native-bootsplash', () => ({ HideOnDraw: () => null }));
jest.mock('@legendapp/list/keyboard', () => ({
  KeyboardAwareLegendList: () => null,
  useKeyboardChatComposerInset: () => ({
    contentInsetEndAdjustment: 0,
    onComposerLayout: () => undefined,
  }),
  useKeyboardScrollToEnd: () => ({
    freeze: false,
    scrollMessageToEnd: () => undefined,
  }),
}));
jest.mock('../src/screens/RecentsScreen', () => ({
  RecentsScreen: () => null,
}));
jest.mock('../src/components/Composer', () => ({ Composer: () => null }));
jest.mock('../src/components/EmptyState', () => ({ EmptyState: () => null }));
jest.mock('../src/components/MessageBubble', () => ({
  MessageBubble: () => null,
}));
jest.mock('../src/components/ScrollToBottomButton', () => ({
  ScrollToBottomButton: () => null,
}));
jest.mock('../src/components/Glass', () => ({
  Glass: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../src/components/Icon', () => ({ Icon: () => null }));

const recents = 0;
const chat = 1;

function chatState(): ChatViewState {
  return {
    chatId: 'chat',
    picker: 'kimi',
    messages: [],
    isStreaming: false,
    recents: [],
    send: () => null,
    stop: () => undefined,
    setPicker: () => undefined,
    newChat: () => undefined,
    openChat: () => undefined,
    loadOlder: () => undefined,
    draftText: () => '',
    saveDraftAfterPause: () => undefined,
    saveDraftsNow: () => undefined,
  };
}

async function renderDrawer(): Promise<ReactTestRenderer> {
  const store = createStore<ChatViewState>()(chatState);
  const rendered = React.createRef<ReactTestRenderer>();
  await act(async () => {
    rendered.current = create(
      <ChatStoreContext.Provider value={store}>
        <RootDrawer />
      </ChatStoreContext.Provider>,
    );
  });
  const renderer = rendered.current;
  if (!renderer) throw new Error('The test renderer was not created.');
  return renderer;
}

test('leaving the chat page closes the open model menu, and the menu is still closed when the chat page shows again', async () => {
  const renderer = await renderDrawer();
  const pager = renderer.root.findByProps({ testID: 'pager' });
  const pill = () =>
    renderer.root.findByProps({
      accessibilityHint: 'Chooses the model for this chat',
    });
  const menu = () => renderer.root.findByProps({ accessibilityRole: 'menu' });
  const selectPage = (position: number) =>
    act(async () => {
      pager.props.onPageSelected({ nativeEvent: { position } });
    });

  await act(async () => pill().props.onPress());
  expect(pill().props.accessibilityState).toEqual({ expanded: true });
  expect(menu().props.pointerEvents).toBe('auto');

  await selectPage(recents);
  expect(pill().props.accessibilityState).toEqual({ expanded: false });
  expect(menu().props.pointerEvents).toBe('none');

  await selectPage(chat);
  expect(pill().props.accessibilityState).toEqual({ expanded: false });
  expect(menu().props.pointerEvents).toBe('none');
});
