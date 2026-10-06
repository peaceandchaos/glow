import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createStore } from 'zustand/vanilla';
import type { ModelKey } from '../../../shared/contracts';
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
const setPicker = jest.fn<void, [ModelKey]>();
const newChat = jest.fn<void, []>();

beforeEach(() => {
  jest.clearAllMocks();
});

function chatState(): ChatViewState {
  return {
    chatId: 'chat',
    picker: 'deepseek',
    messages: [],
    isStreaming: false,
    recents: [],
    send: () => null,
    stop: () => undefined,
    setPicker,
    newChat,
    openChat: () => undefined,
    loadOlder: () => undefined,
    draftText: () => '',
    saveDraftAfterPause: () => undefined,
    saveDraftsNow: () => undefined,
  };
}

async function renderDrawer() {
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
  const root = renderer.root;
  const pager = root.findByProps({ testID: 'pager' });
  const pill = () =>
    root.findByProps({ accessibilityHint: 'Chooses the model for this chat' });
  const menu = () => root.findByProps({ accessibilityRole: 'menu' });
  return {
    root,
    menu,
    expanded: (): boolean => pill().props.accessibilityState.expanded,
    option: (label: string) =>
      menu().findByProps({ accessibilityLabel: label }),
    open: () => act(async () => pill().props.onPress()),
    selectPage: (position: number) =>
      act(async () => {
        pager.props.onPageSelected({ nativeEvent: { position } });
      }),
  };
}

test('leaving the chat page closes the open model menu, and the menu is still closed when the chat page shows again', async () => {
  const view = await renderDrawer();

  await view.open();
  expect(view.expanded()).toBe(true);
  expect(view.menu().props.pointerEvents).toBe('auto');

  await view.selectPage(recents);
  expect(view.expanded()).toBe(false);
  expect(view.menu().props.pointerEvents).toBe('none');

  await view.selectPage(chat);
  expect(view.expanded()).toBe(false);
  expect(view.menu().props.pointerEvents).toBe('none');
});

test('the menu marks the model the chat uses, and picking another model hands it to the chat and closes the menu', async () => {
  const view = await renderDrawer();
  await view.open();
  expect(view.option('DeepSeek V4.1 Flash').props.accessibilityState).toEqual({
    selected: true,
  });
  expect(view.option('Kimi K3').props.accessibilityState).toEqual({
    selected: false,
  });

  await act(async () => view.option('Kimi K3').props.onPress());
  expect(setPicker.mock.calls).toEqual([['kimi']]);
  expect(view.expanded()).toBe(false);
  expect(view.menu().props.pointerEvents).toBe('none');
});

test('the scrim, Recents, and New chat each close the open menu', async () => {
  const view = await renderDrawer();
  const controls = [
    { label: 'Dismiss model menu', handler: 'onPressIn' },
    { label: 'Recents', handler: 'onPress' },
    { label: 'New chat', handler: 'onPress' },
  ];

  for (const { label, handler } of controls) {
    await view.open();
    expect({ label, expanded: view.expanded() }).toEqual({
      label,
      expanded: true,
    });
    await act(async () =>
      view.root.findByProps({ accessibilityLabel: label }).props[handler](),
    );
    expect({ label, expanded: view.expanded() }).toEqual({
      label,
      expanded: false,
    });
  }
  expect(newChat).toHaveBeenCalledTimes(1);
});
