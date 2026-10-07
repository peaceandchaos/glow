import { z } from 'zod';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { parseCatalog, type Catalog } from '../../../../shared/catalog';
import type { LevelKey, Picker } from '../../../../shared/contracts';
import type { ReplyLabel } from '../../../../shared/provider-events';
import type { ChatArchive, ChatRecord, SavedMessage } from './archive';
import type { AttemptActivity, ChatSession } from './session';

export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'streaming' | 'done' | 'error';

export type Attachment = { uri: string; dataUrl: string };

export type Message = {
  id: string;
  role: MessageRole;
  text: string;
  status: MessageStatus;
  attachments?: string[];
  reasoning?: string;
  statusLabel?: ReplyLabel;
  // Set on a user turn sent with another model choice than the turn before it.
  modelSwitch?: { from: Picker; to: Picker };
};

export type ChatViewState = {
  chatId: string;
  picker: Picker;
  level: LevelKey | undefined;
  catalog: Catalog;
  // The newest part of the chat's path. loadOlder() adds earlier messages.
  messages: Message[];
  isStreaming: boolean;
  // Chats with a sent message, most recently updated first.
  recents: ChatRecord[];
  // Returns the saved user turn's id, or null when nothing was saved.
  send: (text: string, attachments?: Attachment[]) => string | null;
  stop: () => void;
  setPicker: (picker: Picker) => void;
  setLevel: (level: LevelKey) => void;
  newChat: () => void;
  openChat: (chatId: string) => void;
  loadOlder: () => void;
  draftText: (chatId: string) => string;
  saveDraftAfterPause: (chatId: string, text: string) => void;
  saveDraftsNow: () => void;
  // Takes a fetched catalog body; an unreadable one keeps the current catalog.
  receiveCatalog: (body: string) => void;
};

export const historyPage = 50;
export const draftPauseMs = 500;

export type ChatStore = StoreApi<ChatViewState>;

function replyStatus(
  saved: SavedMessage,
  activity: AttemptActivity,
): MessageStatus {
  if (activity.kind === 'halted') return 'error';
  switch (saved.status) {
    case 'completed':
    case 'stopped':
    case 'deleted':
      return 'done';
    case 'failed':
    case 'interrupted':
      return 'error';
    case 'pending':
    case 'accepted':
    case 'selecting':
    case 'compacting':
    case 'generating':
      return 'streaming';
  }
}

export function toMessage(
  saved: SavedMessage,
  activity: AttemptActivity,
  localImagePaths?: string[],
  previousPicker?: Picker,
): Message {
  if (saved.role === 'user')
    return {
      id: saved.id,
      role: 'user',
      text: saved.text,
      status: 'done',
      attachments: localImagePaths,
      modelSwitch:
        previousPicker && previousPicker !== saved.picker
          ? { from: previousPicker, to: saved.picker }
          : undefined,
    };
  return {
    id: saved.id,
    role: 'assistant',
    text: saved.text,
    status: replyStatus(saved, activity),
    reasoning: saved.reasoning || undefined,
    statusLabel: activity.kind === 'connected' ? activity.label : undefined,
  };
}

function sameMessage(a: Message, b: Message): boolean {
  return (
    a.text === b.text &&
    a.status === b.status &&
    a.reasoning === b.reasoning &&
    a.statusLabel === b.statusLabel &&
    a.attachments === b.attachments &&
    a.modelSwitch?.from === b.modelSwitch?.from
  );
}

const unavailable = 'Saved chats are unavailable.';

function settled(saved: SavedMessage): boolean {
  return saved.role === 'user' || saved.acknowledged;
}

export function createChatView(
  archive: ChatArchive,
  session: ChatSession,
  report: (error: string) => void,
): ChatStore {
  const rows = new Map<string, { saved: SavedMessage; view: Message }>();
  const sentImages = new Map<string, string[]>();
  const storedDrafts = new Map<string, string>();
  const pendingDrafts = new Map<
    string,
    { text: string; timer: ReturnType<typeof setTimeout> }
  >();

  const cancelPendingDraft = (chatId: string): void => {
    clearTimeout(pendingDrafts.get(chatId)?.timer);
    pendingDrafts.delete(chatId);
  };
  const storeDraft = (chatId: string, text: string): void => {
    cancelPendingDraft(chatId);
    try {
      archive.saveDraft(chatId, text);
      storedDrafts.set(chatId, text);
    } catch {}
  };

  function attempt<T>(action: () => T, invalid = unavailable): T | null {
    try {
      return action();
    } catch (error) {
      report(
        error instanceof Error && !(error instanceof z.ZodError)
          ? error.message
          : invalid,
      );
      return null;
    }
  }

  // A user turn's parent is the previous reply, saved with the previous turn's
  // choice. Rows view in path order, so a shown parent is already in `rows`;
  // loadOlder views the old first row again once its parent is shown.
  const view = (saved: SavedMessage): Message => {
    const previous = rows.get(saved.id)?.view;
    const next = toMessage(
      saved,
      session.activity(saved.id),
      sentImages.get(saved.id),
      saved.parentId ? rows.get(saved.parentId)?.saved.picker : undefined,
    );
    const kept = previous && sameMessage(previous, next) ? previous : next;
    rows.set(saved.id, { saved, view: kept });
    return kept;
  };

  const streaming = (messages: Message[]): boolean =>
    messages.at(-1)?.status === 'streaming';
  const show = (chatId: string, messages: Message[]): void =>
    store.setState({
      chatId,
      messages,
      isStreaming: streaming(messages),
    });

  const newestPage = (chat: ChatRecord): SavedMessage[] =>
    session.path(chat.leafId, historyPage);
  const showPage = (chat: ChatRecord, path: SavedMessage[]): void => {
    rows.clear();
    const messages = path.map(view);
    store.setState({
      chatId: chat.id,
      picker: chat.picker,
      level: chat.level,
      messages,
      isStreaming: streaming(messages),
    });
  };

  const refresh = (): void => {
    const { chatId, messages, isStreaming } = store.getState();
    let changed = false;
    const next = messages.map(message => {
      const row = rows.get(message.id);
      if (!row || settled(row.saved)) return message;
      const updated = view(session.message(message.id));
      if (updated !== message) changed = true;
      return updated;
    });
    if (changed || isStreaming !== streaming(next)) show(chatId, next);
  };

  const catalog = archive.catalog();
  const store: ChatStore = createStore<ChatViewState>()(() => ({
    chatId: '',
    picker: catalog.models[0].key,
    level: undefined,
    catalog,
    messages: [],
    isStreaming: false,
    recents: [],
    send: (text, attachments = []) => {
      const { chatId } = store.getState();
      // Only a new turn's images can fail the saved-message schema.
      const reply = attempt(
        () =>
          session.send(
            chatId,
            text,
            attachments.map(attachment => attachment.dataUrl),
          ),
        'These images can’t be sent.',
      );
      if (!reply) return null;
      storeDraft(chatId, '');
      const userId = reply.parentId;
      if (userId && attachments.length > 0)
        sentImages.set(
          userId,
          attachments.map(attachment => attachment.uri),
        );
      const user = userId ? attempt(() => session.message(userId)) : null;
      const turn = user ? [user, reply] : [reply];
      show(chatId, [...store.getState().messages, ...turn.map(view)]);
      attempt(() => store.setState({ recents: archive.recents() }));
      return userId;
    },
    stop: () => {
      const leaf = store.getState().messages.at(-1);
      if (leaf?.status === 'streaming') attempt(() => session.stop(leaf.id));
    },
    setPicker: picker =>
      attempt(() => {
        archive.setPicker(store.getState().chatId, picker);
        store.setState({ picker, level: undefined });
      }),
    setLevel: level =>
      attempt(() => {
        archive.setLevel(store.getState().chatId, level);
        store.setState({ level });
      }),
    newChat: () =>
      attempt(() => {
        const current = archive.chat(store.getState().chatId);
        if (current.leafId === null) return;
        const chat = archive.createChat(store.getState().catalog.models[0].key);
        showPage(chat, newestPage(chat));
      }),
    openChat: chatId =>
      attempt(() => {
        if (chatId === store.getState().chatId) return;
        const chat = archive.chat(chatId);
        const path = newestPage(chat);
        archive.openChat(chatId);
        showPage(chat, path);
      }),
    loadOlder: () =>
      attempt(() => {
        const { messages } = store.getState();
        const oldest = rows.get(messages[0]?.id ?? '')?.saved;
        if (!oldest?.parentId) return;
        const older = session.path(oldest.parentId, historyPage).map(view);
        const [, ...rest] = messages;
        store.setState({ messages: [...older, view(oldest), ...rest] });
      }),
    draftText: chatId => {
      const known = pendingDrafts.get(chatId)?.text ?? storedDrafts.get(chatId);
      if (known !== undefined) return known;
      try {
        const text = archive.draft(chatId);
        storedDrafts.set(chatId, text);
        return text;
      } catch {
        return '';
      }
    },
    saveDraftAfterPause: (chatId, text) => {
      cancelPendingDraft(chatId);
      if (storedDrafts.get(chatId) === text) return;
      const timer = setTimeout(() => storeDraft(chatId, text), draftPauseMs);
      pendingDrafts.set(chatId, { text, timer });
    },
    saveDraftsNow: () => {
      for (const [chatId, { text }] of pendingDrafts) storeDraft(chatId, text);
    },
    receiveCatalog: body => {
      const next = parseCatalog(body);
      if (!next) return;
      try {
        archive.saveCatalog(body);
        store.setState({ catalog: next });
      } catch {}
    },
  }));

  const currentId = archive.metadata().currentChatId;
  const opened = currentId
    ? archive.chat(currentId)
    : archive.createChat(catalog.models[0].key);
  showPage(opened, newestPage(opened));
  store.setState({ recents: archive.recents() });
  session.subscribe(refresh);
  return store;
}
