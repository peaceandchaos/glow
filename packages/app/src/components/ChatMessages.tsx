import * as React from 'react';
import { useState } from 'react';
import { useChatStore, type Message } from '../state/chatStore';

type ChatMessagesProps = {
  children: (messages: Message[], addedOlder: boolean) => React.ReactElement;
};

// `addedOlder` is true when the latest change put older history above the
// rows shown: the first message changed and the last did not.
export function ChatMessages({ children }: ChatMessagesProps) {
  const messages = useChatStore(state => state.messages);
  const [shown, setShown] = useState({ messages, addedOlder: false });
  if (shown.messages !== messages) {
    const firstChanged = messages[0]?.id !== shown.messages[0]?.id;
    const lastKept = messages.at(-1)?.id === shown.messages.at(-1)?.id;
    setShown({ messages, addedOlder: firstChanged && lastKept });
  }
  return children(messages, shown.addedOlder);
}
