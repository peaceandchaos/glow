import { createRef } from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createStore } from 'zustand/vanilla';
import { bakedCatalog } from '../../../shared/catalog';
import { MessageBubble } from '../src/components/MessageBubble';
import { ChatStoreContext, type Message } from '../src/state/chatStore';
import type { ChatViewState } from '../src/state/chatView';

jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native');
  const entering = { delay: () => entering, duration: () => entering };
  return {
    __esModule: true,
    default: { View },
    Easing: { out: () => undefined, exp: undefined },
    FadeIn: entering,
    SlideInDown: { easing: () => entering },
  };
});
jest.mock('react-native-nitro-image', () => ({ NitroImage: () => null }));
jest.mock('react-native-enriched-markdown', () => ({
  EnrichedMarkdownText: () => null,
}));
jest.mock('../src/components/Icon', () => ({
  Icon: (props: { name: string }) => `icon:${props.name}`,
}));
jest.mock('../src/components/ShimmerText', () => ({
  ShimmerText: (props: { text: string }) => `shimmer:${props.text}`,
}));

function waitingRow(statusLabel?: Message['statusLabel']) {
  const rendered = createRef<ReactTestRenderer>();
  act(() => {
    rendered.current = create(
      <MessageBubble
        message={{
          id: 'reply',
          role: 'assistant',
          text: '',
          status: 'streaming',
          statusLabel,
        }}
        onOpenReasoning={() => undefined}
      />,
    );
  });
  const renderer = rendered.current;
  if (!renderer) throw new Error('The test renderer was not created.');
  return renderer.toJSON();
}

test('a waiting reply shows Thinking with sparkles until the server says it is responding', () => {
  expect(JSON.stringify(waitingRow())).toContain(
    '"icon:sparkles","shimmer:Thinking"',
  );
  expect(JSON.stringify(waitingRow('Thinking'))).toContain(
    '"icon:sparkles","shimmer:Thinking"',
  );
  expect(JSON.stringify(waitingRow('Responding'))).toContain(
    '"icon:text.bubble","shimmer:Responding"',
  );
});

test('a user turn sent after a model switch shows the switch with catalog labels above its bubble', () => {
  const store = createStore<ChatViewState>()(() => ({
    chatId: 'chat',
    picker: 'auto',
    level: undefined,
    catalog: bakedCatalog,
    messages: [],
    isStreaming: false,
    recents: [],
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
  }));
  const turn = (modelSwitch?: Message['modelSwitch']) => {
    const rendered = createRef<ReactTestRenderer>();
    act(() => {
      rendered.current = create(
        <ChatStoreContext.Provider value={store}>
          <MessageBubble
            message={{
              id: 'turn',
              role: 'user',
              text: 'Hello',
              status: 'done',
              modelSwitch,
            }}
            onOpenReasoning={() => undefined}
          />
        </ChatStoreContext.Provider>,
      );
    });
    const renderer = rendered.current;
    if (!renderer) throw new Error('The test renderer was not created.');
    return renderer.root
      .findAllByType(Text)
      .map(node => [node.props.children].flat().join(''));
  };

  expect(turn({ from: 'deepseek', to: 'auto' })).toEqual([
    'Model switched from DeepSeek V4.1 Flash to Auto',
    'Hello',
  ]);
  expect(turn({ from: 'auto', to: 'gpt-6.1-sol' })).toEqual([
    'Model switched from Auto to GPT-6.1 Sol',
    'Hello',
  ]);
  expect(turn()).toEqual(['Hello']);
});
