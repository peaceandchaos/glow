import React from 'react';
import { AppState, Text, TextInput, type AppStateStatus } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createStore } from 'zustand/vanilla';
import { bakedCatalog } from '../../../shared/catalog';
import type { SearchHit } from '../../../shared/contracts';
import { seedChat } from '../harness/seed';
import type { ChatTransport } from '../src/network/transport';
import { RecentsScreen } from '../src/screens/RecentsScreen';
import {
  ChatArchive,
  type ArchiveStorage,
  type ChatRecord,
} from '../src/state/archive';
import { ChatStoreContext } from '../src/state/chatStore';
import {
  createChatView,
  type ChatStore,
  type ChatViewState,
} from '../src/state/chatView';
import { ChatSession } from '../src/state/session';

type ListProps = {
  data: { id: string }[];
  renderItem: (info: {
    item: { id: string };
    index: number;
  }) => React.ReactNode;
  ListHeaderComponent?: React.ReactNode;
  ListFooterComponent?: React.ReactNode;
};
jest.mock('@legendapp/list/react-native', () => {
  const { Fragment, createElement } = jest.requireActual('react');
  return {
    LegendList: ({
      data,
      renderItem,
      ListHeaderComponent,
      ListFooterComponent,
    }: ListProps) => [
      createElement(Fragment, { key: 'header' }, ListHeaderComponent),
      ...data.map((item, index) =>
        createElement(Fragment, { key: item.id }, renderItem({ item, index })),
      ),
      createElement(Fragment, { key: 'footer' }, ListFooterComponent),
    ],
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

const mounted: ReactTestRenderer[] = [];

function render(store: ChatStore): ReactTestRenderer {
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
  mounted.push(renderer);
  return renderer;
}

function textsOf(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(text => text.props.children)
    .filter(child => typeof child === 'string');
}

function renderRecents(): () => string[] {
  const store = createStore<ChatViewState>()(() => ({
    chatId: chat.id,
    picker: 'kimi',
    level: undefined,
    catalog: bakedCatalog,
    messages: [],
    isStreaming: false,
    recents: [chat],
    send: () => null,
    stop: () => undefined,
    setPicker: () => undefined,
    setLevel: () => undefined,
    newChat: () => undefined,
    openChat: () => undefined,
    loadOlder: () => undefined,
    draftText: () => '',
    saveDraftAfterPause: () => undefined,
    saveDraftsNow: () => undefined,
    receiveCatalog: () => undefined,
    serverHits: { query: '', hits: [] },
    synced: () => undefined,
    searchServer: () => undefined,
  }));
  const renderer = render(store);
  return () => textsOf(renderer);
}

// A real archive and view with no network; search answers from `answer`.
function searchableRecents(answer: () => Promise<SearchHit[]>) {
  const values = new Map<string, string>();
  const storage: ArchiveStorage = {
    getString: key => values.get(key),
    getAllKeys: () => [...values.keys()],
    set: (key, value) => {
      values.set(key, value);
    },
    remove: key => {
      values.delete(key);
    },
  };
  let next = 0;
  const archive = new ChatArchive(storage, () => {
    next += 1;
    return `00000000-0000-4000-8000-${next.toString(16).padStart(12, '0')}`;
  });
  archive.recover();
  const fourier = seedChat(archive, [
    { question: 'Fourier series', answer: 'Sums of sines.' },
  ]);
  const cooking = seedChat(archive, [
    { question: 'Weeknight cooking', answer: 'Roast the vegetables.' },
  ]);
  const offline = (): never => {
    throw new TypeError('Network request failed');
  };
  const transport: ChatTransport = {
    get: offline,
    submit: offline,
    watch: offline,
    stop: offline,
    acknowledge: offline,
    deleteChat: offline,
    disconnect: () => undefined,
  };
  const session = new ChatSession({
    archive,
    transport,
    scheduleFrame: callback => callback(),
  });
  const store = createChatView(archive, session, () => undefined, answer);
  const renderer = render(store);
  const submit = async (query: string) => {
    const input = renderer.root.findByType(TextInput);
    act(() => {
      input.props.onChangeText(query);
    });
    await act(async () => {
      input.props.onSubmitEditing();
    });
  };
  return { renderer, submit, fourier, cooking };
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
  // A mounted Recents screen keeps its midnight timer alive.
  act(() => {
    for (const renderer of mounted.splice(0)) renderer.unmount();
  });
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

test('server hits show below the title matches, and hits for chats not on this phone are hidden', async () => {
  jest.useRealTimers();
  let hits: SearchHit[] = [];
  const { renderer, submit, fourier, cooking } = searchableRecents(() =>
    Promise.resolve(hits),
  );
  hits = [
    { chatId: fourier, messageId: null, title: 'Fourier series', snippet: '' },
    {
      chatId: cooking,
      messageId: '00000000-0000-4000-8000-0000000000aa',
      title: 'Weeknight cooking',
      snippet: 'the sines of roasting',
    },
    {
      chatId: '00000000-0000-4000-8000-0000000000bb',
      messageId: '00000000-0000-4000-8000-0000000000cc',
      title: 'A chat only on another phone',
      snippet: 'sines elsewhere',
    },
  ];
  await submit('Fourier');
  expect(textsOf(renderer)).toEqual([
    'History',
    'Fourier series',
    'Today',
    'Messages',
    'Weeknight cooking',
    'the sines of roasting',
    'New Chat',
  ]);
});

test('a failed server search keeps the local title matches', async () => {
  jest.useRealTimers();
  const { renderer, submit } = searchableRecents(() =>
    Promise.reject(new TypeError('Network request failed')),
  );
  await submit('Fourier');
  expect(textsOf(renderer)).toEqual([
    'History',
    'Fourier series',
    'Today',
    'New Chat',
  ]);
});
