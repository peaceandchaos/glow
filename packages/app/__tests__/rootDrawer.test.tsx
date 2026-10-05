import React from 'react';
import {
  act,
  create,
  type ReactTestRenderer,
  type ReactTestRendererJSON,
} from 'react-test-renderer';
import { KeyboardController } from 'react-native-keyboard-controller';
import { RootDrawer } from '../src/screens/RootDrawer';

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
  KeyboardController: { dismiss: jest.fn() },
}));
jest.mock('../src/state/chatStore', () => ({
  useChatStore: <T,>(select: (state: { newChat: () => void }) => T): T =>
    select({ newChat: () => undefined }),
}));
jest.mock('../src/screens/RecentsScreen', () => {
  const { View } = require('react-native');
  return { RecentsScreen: () => <View testID="recents" /> };
});
jest.mock('../src/screens/ChatScreen', () => {
  const { View } = require('react-native');
  return { ChatScreen: () => <View testID="chat" /> };
});

function shownTestIDs(
  node: ReactTestRendererJSON | ReactTestRendererJSON[] | null,
): string[] {
  if (node === null) {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap(shownTestIDs);
  }
  const own = typeof node.props.testID === 'string' ? [node.props.testID] : [];
  const children = (node.children ?? []).flatMap(child =>
    typeof child === 'string' ? [] : shownTestIDs(child),
  );
  return [...own, ...children];
}

async function renderDrawer(): Promise<ReactTestRenderer> {
  const rendered = React.createRef<ReactTestRenderer>();
  await act(async () => {
    rendered.current = create(<RootDrawer />);
  });
  const renderer = rendered.current;
  if (!renderer) throw new Error('The test renderer was not created.');
  return renderer;
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('showing Recents keeps the chat page rendered', async () => {
  const renderer = await renderDrawer();
  const pager = renderer.root.findByProps({ testID: 'pager' });

  await act(async () => {
    pager.props.onPageSelected({ nativeEvent: { position: 0 } });
    pager.props.onPageScrollStateChanged?.({
      nativeEvent: { pageScrollState: 'idle' },
    });
  });

  expect(shownTestIDs(renderer.toJSON())).toEqual(['pager', 'recents', 'chat']);
});

test('every page change closes the keyboard, and the initial page does not', async () => {
  const renderer = await renderDrawer();
  const pager = renderer.root.findByProps({ testID: 'pager' });
  const selectPage = (position: number) =>
    act(async () => {
      pager.props.onPageSelected({ nativeEvent: { position } });
    });
  const recents = 0;
  const chat = 1;

  await selectPage(chat);
  expect(KeyboardController.dismiss).not.toHaveBeenCalled();

  await selectPage(recents);
  expect(KeyboardController.dismiss).toHaveBeenCalledTimes(1);

  await selectPage(chat);
  expect(KeyboardController.dismiss).toHaveBeenCalledTimes(2);
});
