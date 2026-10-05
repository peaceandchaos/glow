import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useStore as mockUseStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { SendResult } from '../src/components/Composer';
import { ChatScreen } from '../src/screens/ChatScreen';
import type { ChatViewState, Message } from '../src/state/chatView';

type AnchoredEndSpace = {
  anchorIndex: number;
  onSizeChanged: (size: number) => void;
};
type ListProps = {
  ref: { current: unknown };
  anchoredEndSpace?: AnchoredEndSpace;
  initialScrollAtEnd?: boolean;
  maintainScrollAtEnd?: unknown;
  maintainVisibleContentPosition?: unknown;
  onScrollBeginDrag: () => void;
  onEndVisible: (visible: boolean) => void;
};
type RenderedList = { props?: ListProps };
const mockList: RenderedList = {};
const mockScrollToEnd = jest.fn();
type ComposerProps = {
  onSubmit: (text: string, attachments: []) => SendResult;
};
type RenderedComposer = { props?: ComposerProps };
const mockComposer: RenderedComposer = {};

jest.mock('@legendapp/list/keyboard', () => ({
  KeyboardAwareLegendList: (props: ListProps) => {
    mockList.props = props;
    props.ref.current = { scrollToEnd: mockScrollToEnd };
    return null;
  },
  useKeyboardChatComposerInset: () => ({
    contentInsetEndAdjustment: 0,
    onComposerLayout: () => undefined,
  }),
  useKeyboardScrollToEnd: () => ({
    freeze: false,
    scrollMessageToEnd: () => undefined,
  }),
}));
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardStickyView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('react-native-bootsplash', () => ({ HideOnDraw: () => null }));
jest.mock('../src/components/Header', () => ({ Header: () => null }));
jest.mock('../src/components/Composer', () => ({
  Composer: (props: ComposerProps) => {
    mockComposer.props = props;
    return null;
  },
}));
jest.mock('../src/components/EmptyState', () => ({ EmptyState: () => null }));
jest.mock('../src/components/MessageBubble', () => ({
  MessageBubble: () => null,
}));
jest.mock('../src/components/ScrollToBottomButton', () => ({
  ScrollToBottomButton: () => null,
}));

let mockStore: StoreApi<ChatViewState>;
jest.mock('../src/state/chatStore', () => ({
  useChatStore: <T,>(select: (current: ChatViewState) => T): T =>
    mockUseStore(mockStore, select),
}));

const followTail = { on: { dataChange: true, itemLayout: true } };

function chatState(isStreaming: boolean): ChatViewState {
  return {
    chatId: 'chat',
    messages: [
      { id: 'question', role: 'user', text: 'Question', status: 'done' },
      {
        id: 'reply',
        role: 'assistant',
        text: 'Partial',
        status: isStreaming ? 'streaming' : 'done',
      },
    ],
    isStreaming,
    recents: [],
    send: () => null,
    stop: () => undefined,
    newChat: () => undefined,
    openChat: () => undefined,
    loadOlder: () => undefined,
    draftText: () => '',
    saveDraftAfterPause: () => undefined,
    saveDraftsNow: () => undefined,
  };
}

function openChat(isStreaming: boolean) {
  mockStore = createStore(() => chatState(isStreaming));
  act(() => {
    create(<ChatScreen onOpenRecents={() => undefined} openCount={0} />);
  });
  return {
    change: (messages: Message[]) => {
      act(() => mockStore.setState({ messages }));
      return mockList.props?.maintainVisibleContentPosition;
    },
    finish: () => {
      act(() => mockStore.setState(chatState(false)));
    },
  };
}

test('a reply still streaming when its chat opens, as after a relaunch, is followed to the end, and a drag pauses it', () => {
  const chat = openChat(true);
  expect(mockList.props?.initialScrollAtEnd).toBe(true);
  expect(mockList.props?.maintainScrollAtEnd).toEqual(followTail);

  act(() => mockList.props?.onScrollBeginDrag());
  expect(mockList.props?.maintainScrollAtEnd).toBeUndefined();

  act(() => mockList.props?.onEndVisible(true));
  expect(mockList.props?.maintainScrollAtEnd).toEqual(followTail);

  // The finished reply's action row is followed into view too.
  chat.finish();
  expect(mockList.props?.maintainScrollAtEnd).toEqual(followTail);
});

test('a chat whose reply has finished opens without following', () => {
  openChat(false);
  expect(mockList.props?.maintainScrollAtEnd).toBeUndefined();
});

test('the list holds the rows on screen only for the change that adds an older page', () => {
  const chat = openChat(true);
  const messages = () => mockStore.getState().messages;
  const older = (n: number): Message[] => [
    { id: `older-${n}`, role: 'user', text: 'Earlier', status: 'done' },
    { id: `older-${n}-reply`, role: 'assistant', text: 'Yes', status: 'done' },
  ];
  expect(mockList.props?.maintainVisibleContentPosition).toEqual({
    data: false,
  });

  expect(chat.change([...older(1), ...messages()])).toEqual({ data: true });
  const reply = messages()[messages().length - 1];
  expect(
    chat.change([
      ...messages().slice(0, -1),
      { ...reply, text: 'Partial and more' },
    ]),
  ).toEqual({ data: false });

  expect(chat.change([...older(2), ...messages()])).toEqual({ data: true });
  expect(
    chat.change([
      ...messages(),
      { id: 'next', role: 'user', text: 'Next', status: 'done' },
      { id: 'next-reply', role: 'assistant', text: '', status: 'streaming' },
    ]),
  ).toEqual({ data: false });
});

const question = (id: string): Message => ({
  id,
  role: 'user',
  text: 'Question',
  status: 'done',
});
const answer = (id: string, status: Message['status']): Message => ({
  id,
  role: 'assistant',
  text: 'Answer',
  status,
});

function chatWith(chats: Record<string, Message[]>, open: string) {
  const show = (chatId: string, messages: Message[]) =>
    mockStore.setState({
      chatId,
      messages,
      isStreaming: messages.at(-1)?.status === 'streaming',
    });
  // What a send does to the chat view: saves the turn and shows the rows it
  // could read.
  type Sent = { userId: string; rows: Message[] };
  let sent: Sent = { userId: '', rows: [] };
  mockStore = createStore(() => ({
    ...chatState(false),
    chatId: open,
    messages: chats[open],
    send: () => {
      const { chatId, messages } = mockStore.getState();
      chats[chatId] = [...messages, ...sent.rows];
      show(chatId, chats[chatId]);
      return sent.userId;
    },
  }));
  let openCount = 0;
  const screen = () => (
    <ChatScreen onOpenRecents={() => undefined} openCount={openCount} />
  );
  const rendered = React.createRef<ReactTestRenderer>();
  act(() => {
    rendered.current = create(screen());
  });
  const renderer = rendered.current;
  if (!renderer) throw new Error('The test renderer was not created.');
  return {
    sendShowing: (userId: string, rows: Message[]) => {
      sent = { userId, rows };
      act(() => {
        mockComposer.props?.onSubmit('Question', []);
      });
    },
    // Opening a chat from Recents, which may be the chat already shown.
    openFromRecents: (chatId: string) => {
      openCount += 1;
      act(() => {
        show(chatId, chats[chatId]);
        renderer.update(screen());
      });
    },
  };
}

test('the anchored end space belongs to the sent user turn, wherever that turn is in the list', () => {
  const chats = {
    a: [question('a1'), answer('a1-reply', 'done')],
    b: [question('b1'), answer('b1-reply', 'done')],
  };
  const chat = chatWith(chats, 'a');
  expect(mockList.props?.anchoredEndSpace).toBeUndefined();

  chat.sendShowing('a2', [question('a2'), answer('a2-reply', 'streaming')]);
  expect(mockList.props?.anchoredEndSpace?.anchorIndex).toBe(2);

  // Chat b was not sent in this launch, so it shows no anchored end space.
  chat.openFromRecents('b');
  expect(mockList.props?.anchoredEndSpace).toBeUndefined();
  chat.openFromRecents('a');
  expect(mockList.props?.anchoredEndSpace?.anchorIndex).toBe(2);

  // A send whose user turn could not be read back shows only the reply.
  chat.openFromRecents('b');
  chat.sendShowing('b2', [answer('b2-reply', 'streaming')]);
  expect(mockList.props?.anchoredEndSpace).toBeUndefined();
});

test('opening the chat already shown from Recents scrolls it to the newest message', () => {
  const chat = chatWith(
    { a: [question('a1'), answer('a1-reply', 'done')] },
    'a',
  );
  mockScrollToEnd.mockClear();
  chat.openFromRecents('a');
  expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: false });
});
