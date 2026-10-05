import React from 'react';
import { AppState, Text, type AppStateStatus } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createStore } from 'zustand/vanilla';
import { RecentsScreen } from '../src/screens/RecentsScreen';
import type { ChatRecord } from '../src/state/archive';
import { ChatStoreContext } from '../src/state/chatStore';
import type { ChatViewState } from '../src/state/chatView';

type ListProps = {
  data: { id: string }[];
  renderItem: (info: {
    item: { id: string };
    index: number;
  }) => React.ReactNode;
};
jest.mock('@legendapp/list/react-native', () => {
  const { Fragment, createElement } = jest.requireActual('react');
  return {
    LegendList: ({ data, renderItem }: ListProps) =>
      data.map((item, index) =>
        createElement(Fragment, { key: item.id }, renderItem({ item, index })),
      ),
  };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('../src/components/Glass', () => ({
  Glass: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../src/components/Icon', () => ({ Icon: () => null }));

const chat: ChatRecord = {
  version: 1,
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Fourier series',
  picker: 'auto',
  createdAt: new Date(2026, 9, 2, 9, 0).getTime(),
  updatedAt: new Date(2026, 9, 2, 9, 0).getTime(),
  basePathId: '00000000-0000-4000-8000-000000000002',
  leafId: '00000000-0000-4000-8000-000000000003',
};

function renderRecents(): () => string[] {
  const store = createStore<ChatViewState>()(() => ({
    chatId: chat.id,
    messages: [],
    isStreaming: false,
    recents: [chat],
    send: () => null,
    stop: () => undefined,
    newChat: () => undefined,
    openChat: () => undefined,
    loadOlder: () => undefined,
    draftText: () => '',
    saveDraftAfterPause: () => undefined,
    saveDraftsNow: () => undefined,
  }));
  const rendered = React.createRef<ReactTestRenderer>();
  act(() => {
    rendered.current = create(
      <ChatStoreContext.Provider value={store}>
        <RecentsScreen
          onNewChat={() => undefined}
          onOpenChat={() => undefined}
        />
      </ChatStoreContext.Provider>,
    );
  });
  const renderer = rendered.current;
  if (!renderer) throw new Error('The test renderer was not created.');
  return () =>
    renderer.root
      .findAllByType(Text)
      .map(text => text.props.children)
      .filter(child => typeof child === 'string');
}

let appStateChange: ((state: AppStateStatus) => void) | null = null;
beforeEach(() => {
  jest.useFakeTimers();
  appStateChange = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
    appStateChange = listener;
    return { remove: () => undefined };
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('a chat from today is relabelled "1d ago" when midnight passes on the open screen', () => {
  jest.setSystemTime(new Date(2026, 9, 2, 23, 59));
  const texts = renderRecents();
  expect(texts()).toContain('Today');
  act(() => {
    jest.advanceTimersByTime(2 * 60 * 1000);
  });
  expect(texts()).toContain('1d ago');
});

test('a chat from today is relabelled "1d ago" when the app returns the next day', () => {
  jest.setSystemTime(new Date(2026, 9, 2, 22, 0));
  const texts = renderRecents();
  expect(texts()).toContain('Today');
  jest.setSystemTime(new Date(2026, 9, 3, 8, 0));
  act(() => {
    appStateChange?.('active');
  });
  expect(texts()).toContain('1d ago');
});
