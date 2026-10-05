import { createRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MessageBubble } from '../src/components/MessageBubble';
import type { Message } from '../src/state/chatStore';

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
