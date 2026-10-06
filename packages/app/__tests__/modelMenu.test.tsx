import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createStore } from 'zustand/vanilla';
import { bakedCatalog } from '../../../shared/catalog';
import type { Picker } from '../../../shared/contracts';
import { Icon } from '../src/components/Icon';
import { RootDrawer } from '../src/screens/RootDrawer';
import { ChatStoreContext } from '../src/state/chatStore';
import type { ChatViewState } from '../src/state/chatView';

const mockSetPage = jest.fn<void, [number]>();
jest.mock('react-native-pager-view', () => {
  const { useImperativeHandle } = require('react');
  const { View } = require('react-native');
  function PagerView({
    ref,
    children,
    ...props
  }: {
    ref: React.Ref<{ setPage: (page: number) => void }>;
    children: React.ReactNode;
  }) {
    'use no memo';
    useImperativeHandle(ref, () => ({ setPage: mockSetPage }));
    return (
      <View testID="pager" {...props}>
        {children}
      </View>
    );
  }
  return { __esModule: true, default: PagerView };
});
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardController: { dismiss: () => undefined },
  KeyboardStickyView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  cubicBezier: () => undefined,
  useReducedMotion: () => mockReduceMotion,
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
const setPicker = jest.fn<void, [Picker]>();
const newChat = jest.fn<void, []>();
let mockReduceMotion = false;

beforeEach(() => {
  jest.clearAllMocks();
  mockReduceMotion = false;
});

function chatState(): ChatViewState {
  return {
    chatId: 'chat',
    picker: 'deepseek',
    catalog: bakedCatalog,
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
    receiveCatalog: () => undefined,
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
    store,
    root,
    pill,
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

test('Auto heads the menu, and the chat can go from Auto to a model and back to Auto', async () => {
  const view = await renderDrawer();
  view.store.setState({
    setPicker: picker => {
      setPicker(picker);
      view.store.setState({ picker });
    },
  });
  const options = () =>
    view
      .menu()
      .findAll(
        node =>
          node.props.accessibilityRole === 'button' &&
          typeof node.props.onPress === 'function',
      )
      .map(node => node.props.accessibilityLabel);
  const pickFromMenu = async (label: string) => {
    await view.open();
    await act(async () => view.option(label).props.onPress());
    expect(view.pill().props.accessibilityLabel).toBe(label);
    expect(view.option(label).props.accessibilityState).toEqual({
      selected: true,
    });
  };

  await view.open();
  expect(options()).toEqual([
    'Auto',
    'DeepSeek V4.1 Flash',
    'Kimi K3',
    'GPT-6.1 Sol',
    'GPT-6 Astra',
  ]);
  await act(async () => view.pill().props.onPress());

  await pickFromMenu('Auto');
  await pickFromMenu('Kimi K3');
  expect(view.option('Auto').props.accessibilityState).toEqual({
    selected: false,
  });
  await pickFromMenu('Auto');
  expect(setPicker.mock.calls).toEqual([['auto'], ['kimi'], ['auto']]);
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
  expect(mockSetPage.mock.calls).toEqual([[recents]]);
  expect(newChat).toHaveBeenCalledTimes(1);
});

test('only while the menu is open, the scrim takes touches, the header is modal for VoiceOver, and a tap on the header row between its buttons reaches the scrim', async () => {
  const view = await renderDrawer();
  const row = () =>
    view.root.findByProps({ accessibilityLabel: 'Recents' }).parent;
  const scrim = () =>
    view.root.findByProps({ accessibilityLabel: 'Dismiss model menu' }).parent;
  const header = () => {
    let node = scrim()?.parent;
    while (node && !('accessibilityViewIsModal' in node.props))
      node = node.parent;
    return node;
  };
  expect(row()?.props.pointerEvents ?? 'auto').toBe('auto');
  expect(scrim()?.props.pointerEvents).toBe('none');
  expect(header()?.props.accessibilityViewIsModal).toBe(false);

  await view.open();
  expect(row()?.props.pointerEvents).toBe('box-none');
  expect(scrim()?.props.pointerEvents).toBe('auto');
  expect(header()?.props.accessibilityViewIsModal).toBe(true);

  await act(async () =>
    view.root
      .findByProps({ accessibilityLabel: 'Dismiss model menu' })
      .props.onPressIn(),
  );
  expect(view.expanded()).toBe(false);
  expect(row()?.props.pointerEvents ?? 'auto').toBe('auto');
  expect(scrim()?.props.pointerEvents).toBe('none');
  expect(header()?.props.accessibilityViewIsModal).toBe(false);
});

test('with Reduce Motion, the pill dims on press instead of shrinking, and the open chevron points up without turning', async () => {
  mockReduceMotion = true;
  const view = await renderDrawer();
  const pressed = StyleSheet.flatten(
    view.pill().props.children({ pressed: true }).props.style,
  );
  expect(pressed.transform).toBeUndefined();
  expect(pressed.opacity).toBeLessThan(1);

  await view.open();
  const chevron = view.pill().findByType(Icon);
  expect(chevron.props.name).toBe('chevron.up');
  expect(
    StyleSheet.flatten(chevron.parent?.props.style)?.transform,
  ).toBeUndefined();
});

test('the pill shows the model name on one line', async () => {
  const view = await renderDrawer();
  expect(view.pill().findByType(Text).props.numberOfLines).toBe(1);
});
