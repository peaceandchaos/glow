import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import type { ChatStore, ChatViewState } from './chatView';

export type {
  Attachment,
  Message,
  MessageRole,
  MessageStatus,
} from './chatView';

export const ChatStoreContext = createContext<ChatStore | null>(null);

export function useChatStore<T>(selector: (state: ChatViewState) => T): T {
  const store = useContext(ChatStoreContext);
  if (!store) throw new Error('Chat screens render inside ChatStoreContext.');
  return useStore(store, selector);
}
