import { z } from 'zod';
import {
  attemptStatusSchema,
  checkpointSchema,
  decodeJson,
  idSchema,
  imageSchema,
  isTerminal,
  modelSchema,
  pickerSchema,
  type HistoryEntry,
  type ModelKey,
  type Picker,
  type Submission,
} from '../../../../shared/contracts';

export interface ArchiveStorage {
  getString(key: string): string | undefined;
  getAllKeys(): string[];
  set(key: string, value: string): void;
  remove(key: string): void;
}

const metadataSchema = z.strictObject({
  version: z.literal(1),
  chatIds: z.array(idSchema),
  currentChatId: idSchema.nullable(),
  jobIds: z.array(idSchema),
  deletions: z.array(idSchema),
});
const chatSchema = z.strictObject({
  version: z.literal(1),
  id: idSchema,
  title: z.string(),
  picker: pickerSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  basePathId: idSchema,
  leafId: idSchema.nullable(),
});
const messageSchema = z.strictObject({
  version: z.literal(1),
  id: idSchema,
  chatId: idSchema,
  parentId: idSchema.nullable(),
  pathId: idSchema,
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  images: z.array(imageSchema).max(4),
  createdAt: z.number(),
  status: z.enum(['pending', ...attemptStatusSchema.options]),
  picker: pickerSchema,
  retryModel: modelSchema.nullable(),
  actualModel: modelSchema.nullable(),
  accepted: z.boolean(),
  acknowledged: z.boolean(),
  sequence: z.number().int().nonnegative(),
  cancelPending: z.boolean(),
  error: z.string().nullable(),
  reasoning: z.string(),
  checkpoint: checkpointSchema.nullable(),
});
const journalSchema = z.array(
  z.strictObject({
    key: z.string().startsWith('archive/'),
    value: z.string().nullable(),
  }),
);
export type ChatRecord = z.infer<typeof chatSchema>;
export type SavedMessage = z.infer<typeof messageSchema>;
type ArchiveMetadata = z.infer<typeof metadataSchema>;
type Write = z.infer<typeof journalSchema>[number];

const metaKey = 'archive/index';
const journalKey = 'archive/journal';
const chatKey = (id: string) => `archive/chat/${id}`;
const messageKey = (id: string) => `archive/message/${id}`;
const childrenKey = (chatId: string, parentId: string | null) =>
  `archive/children/${chatId}/${parentId ?? 'root'}`;
const selectedKey = (chatId: string, parentId: string | null) =>
  `archive/selected/${chatId}/${parentId ?? 'root'}`;
const draftKey = (chatId: string) => `archive/draft/${chatId}`;
const write = (
  key: string,
  value: ChatRecord | SavedMessage | ArchiveMetadata | string[] | string,
): Write => ({ key, value: JSON.stringify(value) });

function isActive(message: SavedMessage): boolean {
  return (
    message.role === 'assistant' &&
    (message.status === 'pending' || !isTerminal(message.status))
  );
}

export class ChatArchive {
  private halfAppliedJournal = false;

  constructor(
    private readonly storage: ArchiveStorage,
    private readonly uuid: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  recover(): void {
    this.replayJournal();
    // Validate the index before creating or selecting anything.
    const metadata = this.metadata();
    for (const id of metadata.chatIds) this.chat(id);
  }

  private replayJournal(): void {
    const journal = this.storage.getString(journalKey);
    if (journal !== undefined) this.apply(decodeJson(journalSchema, journal));
    this.halfAppliedJournal = false;
  }

  private readAfterJournal(key: string): string | undefined {
    if (this.halfAppliedJournal) this.replayJournal();
    return this.storage.getString(key);
  }

  private writeOneKey(change: Write): void {
    if (change.value === null) this.storage.remove(change.key);
    else this.storage.set(change.key, change.value);
  }

  private apply(writes: Write[]): void {
    for (const change of writes) this.writeOneKey(change);
    this.storage.remove(journalKey);
  }

  private commit(writes: Write[]): void {
    if (writes.length === 1) this.writeOneKey(writes[0]);
    else this.writeJournaled(writes);
  }

  private writeJournaled(writes: Write[]): void {
    // Replaying the same journal is idempotent if the process exits mid-write.
    this.storage.set(journalKey, JSON.stringify(writes));
    this.halfAppliedJournal = true;
    this.apply(writes);
    this.halfAppliedJournal = false;
  }

  metadata(): ArchiveMetadata {
    const raw = this.readAfterJournal(metaKey);
    if (raw !== undefined) return decodeJson(metadataSchema, raw);
    if (this.storage.getAllKeys().some(key => key.startsWith('archive/')))
      throw new Error(
        'The saved chat index is missing. Stored data was preserved.',
      );
    return {
      version: 1,
      chatIds: [],
      currentChatId: null,
      jobIds: [],
      deletions: [],
    };
  }

  chat(id: string): ChatRecord {
    const raw = this.readAfterJournal(chatKey(id));
    if (raw === undefined)
      throw new Error('A saved chat is missing. Stored data was preserved.');
    const result = decodeJson(chatSchema, raw);
    if (result.id !== id) throw new Error('Saved chat identity mismatch.');
    return result;
  }

  hasChat(id: string): boolean {
    return this.readAfterJournal(chatKey(id)) !== undefined;
  }

  message(id: string): SavedMessage {
    const raw = this.readAfterJournal(messageKey(id));
    if (raw === undefined)
      throw new Error('A saved message is missing. Stored data was preserved.');
    const result = decodeJson(messageSchema, raw);
    if (result.id !== id) throw new Error('Saved message identity mismatch.');
    return result;
  }

  children(chatId: string, parentId: string | null): string[] {
    const raw = this.readAfterJournal(childrenKey(chatId, parentId));
    return raw === undefined ? [] : decodeJson(z.array(idSchema), raw);
  }

  private selected(chatId: string, parentId: string): string | null {
    const raw = this.readAfterJournal(selectedKey(chatId, parentId));
    return raw === undefined ? null : decodeJson(idSchema, raw);
  }

  recents(): ChatRecord[] {
    const chats: ChatRecord[] = [];
    for (const id of this.metadata().chatIds) {
      const chat = this.chat(id);
      if (chat.leafId) chats.push(chat);
    }
    return chats.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  createChat(): ChatRecord {
    const meta = this.metadata();
    const picker = meta.currentChatId
      ? this.chat(meta.currentChatId).picker
      : 'auto';
    const chat: ChatRecord = {
      version: 1,
      id: this.uuid(),
      title: 'New chat',
      picker,
      createdAt: this.now(),
      updatedAt: this.now(),
      basePathId: this.uuid(),
      leafId: null,
    };
    this.commit([
      write(chatKey(chat.id), chat),
      write(metaKey, {
        ...meta,
        chatIds: [...meta.chatIds, chat.id],
        currentChatId: chat.id,
      }),
    ]);
    return chat;
  }

  openChat(id: string): void {
    this.chat(id);
    this.commit([write(metaKey, { ...this.metadata(), currentChatId: id })]);
  }
  setPicker(id: string, picker: Picker): void {
    this.commit([write(chatKey(id), { ...this.chat(id), picker })]);
  }
  rename(id: string, title: string): void {
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > 120)
      throw new Error('Use a name between 1 and 120 characters.');
    this.commit([write(chatKey(id), { ...this.chat(id), title: trimmed })]);
  }

  ancestry(
    leafId: string | null,
    limit = Number.POSITIVE_INFINITY,
  ): SavedMessage[] {
    const messages: SavedMessage[] = [];
    const seen = new Set<string>();
    let id = leafId;
    let chatId: string | null = null;
    while (id && messages.length < limit) {
      if (seen.has(id))
        throw new Error('The saved conversation contains a cycle.');
      seen.add(id);
      const message = this.message(id);
      if (chatId && message.chatId !== chatId)
        throw new Error('Saved conversation identity mismatch.');
      chatId = message.chatId;
      messages.push(message);
      id = message.parentId;
    }
    return messages.reverse();
  }

  private newMessage(
    chat: ChatRecord,
    role: 'user' | 'assistant',
    parentId: string | null,
    pathId: string,
  ): SavedMessage {
    return {
      version: 1,
      id: this.uuid(),
      chatId: chat.id,
      parentId,
      pathId,
      role,
      text: '',
      images: [],
      createdAt: this.now(),
      status: role === 'user' ? 'completed' : 'pending',
      picker: chat.picker,
      retryModel: null,
      actualModel: null,
      accepted: false,
      acknowledged: false,
      sequence: 0,
      cancelPending: false,
      error: null,
      reasoning: '',
      checkpoint: null,
    };
  }

  private addChild(message: SavedMessage): Write[] {
    return [
      write(messageKey(message.id), message),
      write(childrenKey(message.chatId, message.parentId), [
        ...this.children(message.chatId, message.parentId),
        message.id,
      ]),
      write(selectedKey(message.chatId, message.parentId), message.id),
    ];
  }

  createTurn(chatId: string, rawText: string, images: string[]): SavedMessage {
    const chat = this.chat(chatId);
    const text = rawText.trim();
    if (!text && images.length === 0)
      throw new Error('Write a message or choose an image.');
    const parent = chat.leafId ? this.message(chat.leafId) : null;
    const pathId = parent?.pathId ?? chat.basePathId;
    const meta = this.metadata();
    this.assertIdle(meta, chatId, pathId);
    const user = this.newMessage(chat, 'user', chat.leafId, pathId);
    user.text = text;
    user.images = images;
    messageSchema.parse(user);
    const reply = this.newMessage(chat, 'assistant', user.id, pathId);
    const title = chat.leafId
      ? chat.title
      : [...(text || 'Image conversation').replace(/\s+/gu, ' ')]
          .slice(0, 60)
          .join('');
    this.commit([
      ...this.addChild(user),
      ...this.addChild(reply),
      write(chatKey(chatId), {
        ...chat,
        title,
        leafId: reply.id,
        updatedAt: this.now(),
      }),
      write(metaKey, { ...meta, jobIds: [...meta.jobIds, reply.id] }),
    ]);
    return reply;
  }

  private assertIdle(
    meta: ArchiveMetadata,
    chatId: string,
    pathId: string,
  ): void {
    for (const id of meta.jobIds) {
      const job = this.message(id);
      if (job.chatId === chatId && job.pathId === pathId && isActive(job))
        throw new Error(
          'Wait for this reply or stop it before sending another message.',
        );
    }
  }

  retry(id: string, explicitModel?: ModelKey): SavedMessage {
    const previous = this.message(id);
    if (
      previous.role !== 'assistant' ||
      !previous.parentId ||
      isActive(previous)
    )
      throw new Error('Stop or finish this reply before retrying.');
    // Retry keeps the original attempt's model. An explicit model only fills
    // the gap when Auto failed before any model was saved; it never swaps one.
    const saved =
      previous.actualModel ??
      previous.retryModel ??
      (previous.picker === 'auto' ? null : previous.picker);
    if (saved && explicitModel && explicitModel !== saved)
      throw new Error(`This reply already has a model. Retry uses ${saved}.`);
    const known = saved ?? explicitModel;
    if (!known) throw new Error('Choose a model for this retry.');
    const chat = this.chat(previous.chatId);
    const reply = this.newMessage(
      chat,
      'assistant',
      previous.parentId,
      this.uuid(),
    );
    reply.picker = previous.picker;
    reply.retryModel = known;
    const meta = this.metadata();
    this.commit([
      ...this.addChild(reply),
      write(chatKey(chat.id), {
        ...chat,
        leafId: reply.id,
        updatedAt: this.now(),
      }),
      write(metaKey, { ...meta, jobIds: [...meta.jobIds, reply.id] }),
    ]);
    return reply;
  }

  selectVersion(id: string): void {
    const reply = this.message(id);
    if (reply.role !== 'assistant' || !reply.parentId)
      throw new Error('This message has no reply versions.');
    let leaf = reply;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(leaf.id))
        throw new Error('The saved conversation contains a cycle.');
      seen.add(leaf.id);
      const next = this.selected(reply.chatId, leaf.id);
      if (!next) break;
      const child = this.message(next);
      if (child.parentId !== leaf.id || child.chatId !== reply.chatId)
        throw new Error('Saved continuation identity mismatch.');
      leaf = child;
    }
    this.commit([
      write(selectedKey(reply.chatId, reply.parentId), id),
      write(chatKey(reply.chatId), {
        ...this.chat(reply.chatId),
        leafId: leaf.id,
      }),
    ]);
  }

  submission(id: string): Submission {
    const reply = this.message(id);
    if (reply.role !== 'assistant' || !reply.parentId)
      throw new Error('This is not a reply attempt.');
    const path = this.ancestry(reply.parentId);
    const ids = new Set(path.map(message => message.id));
    const checkpoints = new Map<
      ModelKey,
      NonNullable<SavedMessage['checkpoint']>
    >();
    const history: HistoryEntry[] = path.map(message => {
      if (message.checkpoint && ids.has(message.checkpoint.throughMessageId))
        checkpoints.set(message.checkpoint.model, message.checkpoint);
      return {
        id: message.id,
        parentId: message.parentId,
        role: message.role,
        text: message.text,
        images: message.images,
        complete: message.status === 'completed',
      };
    });
    return {
      version: 1,
      attemptId: reply.id,
      chatId: reply.chatId,
      pathId: reply.pathId,
      userTurnId: reply.parentId,
      picker: reply.picker,
      retryModel: reply.retryModel,
      history,
      checkpoints: [...checkpoints.values()],
    };
  }

  saveMessages(messages: SavedMessage[]): void {
    const writes: Write[] = [];
    for (const message of messages) {
      if (!this.hasChat(message.chatId)) continue;
      const saved = this.message(message.id);
      if (
        saved.chatId !== message.chatId ||
        saved.parentId !== message.parentId ||
        saved.pathId !== message.pathId ||
        saved.role !== message.role
      )
        throw new Error('Message update identity mismatch.');
      writes.push(write(messageKey(message.id), messageSchema.parse(message)));
    }
    if (writes.length) this.commit(writes);
  }

  pendingJobs(): SavedMessage[] {
    return this.metadata().jobIds.map(id => this.message(id));
  }

  acknowledge(id: string): void {
    const message = this.message(id);
    const meta = this.metadata();
    this.commit([
      write(messageKey(id), { ...message, acknowledged: true }),
      write(metaKey, {
        ...meta,
        jobIds: meta.jobIds.filter(job => job !== id),
      }),
    ]);
  }

  draft(chatId: string): string {
    const raw = this.readAfterJournal(draftKey(chatId));
    return raw === undefined ? '' : decodeJson(z.string(), raw);
  }

  saveDraft(chatId: string, text: string): void {
    this.writeOneKey(
      text === ''
        ? { key: draftKey(chatId), value: null }
        : write(draftKey(chatId), text),
    );
  }

  deleteChat(id: string): void {
    this.chat(id);
    const writes: Write[] = [
      { key: chatKey(id), value: null },
      { key: draftKey(id), value: null },
    ];
    const pending = [...this.children(id, null)];
    const messageIds = new Set<string>();
    while (pending.length) {
      const messageId = pending.pop();
      if (!messageId || messageIds.has(messageId)) continue;
      messageIds.add(messageId);
      pending.push(...this.children(id, messageId));
      writes.push(
        { key: messageKey(messageId), value: null },
        { key: childrenKey(id, messageId), value: null },
        { key: selectedKey(id, messageId), value: null },
      );
    }
    writes.push(
      { key: childrenKey(id, null), value: null },
      { key: selectedKey(id, null), value: null },
    );
    const meta = this.metadata();
    const chatIds = meta.chatIds.filter(chatId => chatId !== id);
    this.commit([
      ...writes,
      write(metaKey, {
        ...meta,
        chatIds,
        currentChatId:
          meta.currentChatId === id
            ? (chatIds.at(-1) ?? null)
            : meta.currentChatId,
        jobIds: meta.jobIds.filter(job => !messageIds.has(job)),
        deletions: [...new Set([...meta.deletions, id])],
      }),
    ]);
  }

  finishDeletion(id: string): void {
    const meta = this.metadata();
    this.commit([
      write(metaKey, {
        ...meta,
        deletions: meta.deletions.filter(chatId => chatId !== id),
      }),
    ]);
  }
}
