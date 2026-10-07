import { z } from 'zod';
import {
  bakedCatalog,
  parseCatalog,
  type Catalog,
} from '../../../../shared/catalog';
import {
  attemptStatusSchema,
  chatFieldSchema,
  chatRowSchema,
  checkpointSchema,
  decodeJson,
  idSchema,
  imageSchema,
  isTerminal,
  levelKeySchema,
  modelKeySchema,
  pickerSchema,
  seqSchema,
  type ChatField,
  type ChatRow,
  type HistoryEntry,
  type LevelKey,
  type MessageRow,
  type ModelKey,
  type Picker,
  type Submission,
  type SyncPage,
  type SyncPush,
} from '../../../../shared/contracts';
import { bytesOf, chatRow, fieldHolds, messageRow } from './syncRows';

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
  level: levelKeySchema.optional(),
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
  level: levelKeySchema.optional(),
  retryModel: modelKeySchema.nullable(),
  actualModel: modelKeySchema.nullable(),
  accepted: z.boolean(),
  acknowledged: z.boolean(),
  sequence: z.number().int().nonnegative(),
  cancelPending: z.boolean(),
  error: z.string().nullable(),
  reasoning: z.string(),
  checkpoint: checkpointSchema.nullable(),
});
const outboxSchema = z.strictObject({
  chats: z.record(idSchema, z.array(chatFieldSchema)),
  messages: z.array(idSchema),
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
type Outbox = z.infer<typeof outboxSchema>;
type Write = z.infer<typeof journalSchema>[number];
// What one pulled page changed, for the views that show it.
export type RemoteChange = { chats: Set<string>; deleted: string[] };

const metaKey = 'archive/index';
const journalKey = 'archive/journal';
const chatKey = (id: string) => `archive/chat/${id}`;
const messageKey = (id: string) => `archive/message/${id}`;
const childrenKey = (chatId: string, parentId: string | null) =>
  `archive/children/${chatId}/${parentId ?? 'root'}`;
const selectedKey = (chatId: string, parentId: string | null) =>
  `archive/selected/${chatId}/${parentId ?? 'root'}`;
const draftKey = (chatId: string) => `archive/draft/${chatId}`;
const messagePrefix = 'archive/message/';
const cursorKey = 'archive/sync/cursor';
const outboxKey = 'archive/outbox';
// Pulled chats whose leaf has not arrived yet.
const heldKey = 'archive/sync/held';
// Rows the server would refuse. They stay on this phone only.
const unsyncedKey = 'archive/sync/unsynced';
const pushBytes = 3_000_000;
const pushMessages = 500;
const pushChats = 200;
const allFields = chatFieldSchema.options;
// Outside archive/, so a catalog cached before the first chat never reads as
// a chat archive without its index.
const catalogKey = 'catalog/v1';
// Outside archive/ for the same reason: the Apple user whose chats these are.
const ownerKey = 'owner';
const write = (
  key: string,
  value:
    | ChatRecord
    | SavedMessage
    | ArchiveMetadata
    | Outbox
    | Record<string, ChatRow>
    | string[]
    | string
    | number,
): Write => ({ key, value: JSON.stringify(value) });

// The first Apple user to open the shared store adopts it. Anyone else gets a
// store of their own, so no one sees or pushes another user's chats.
export function ownerStorage(
  owner: string,
  open: (id: string) => ArchiveStorage,
): ArchiveStorage {
  const shared = open('personal-chat.archive.v1');
  const stamp = shared.getString(ownerKey);
  if (stamp === undefined) shared.set(ownerKey, owner);
  return stamp === undefined || stamp === owner
    ? shared
    : open(`personal-chat.archive.v1.${owner}`);
}

function isActive(message: SavedMessage): boolean {
  return (
    message.role === 'assistant' &&
    (message.status === 'pending' || !isTerminal(message.status))
  );
}

export class ChatArchive {
  private halfAppliedJournal = false;
  // Writes collected by inOneCommit. Reads see them before they are saved.
  private staged: Map<string, string | null> | null = null;

  constructor(
    private readonly storage: ArchiveStorage,
    private readonly uuid: () => string,
    private readonly now: () => number = Date.now,
    // Runs after a commit that adds to the outbox.
    private readonly onDirty: () => void = () => undefined,
  ) {}

  recover(): void {
    this.replayJournal();
    // Validate the index before creating or selecting anything.
    const metadata = this.metadata();
    for (const id of metadata.chatIds) this.chat(id);
    if (this.readAfterJournal(cursorKey) === undefined)
      this.seedOutbox(metadata);
  }

  // A store from before sync queues everything it holds except unsettled
  // replies, which acknowledge queues later. The index is written too, so a
  // store holding only sync keys still reads as an archive.
  private seedOutbox(metadata: ArchiveMetadata): void {
    const jobs = new Set(metadata.jobIds);
    const chats: Outbox['chats'] = {};
    for (const id of metadata.chatIds)
      if (this.chat(id).leafId) chats[id] = [...allFields];
    const messages = this.storage
      .getAllKeys()
      .filter(key => key.startsWith(messagePrefix))
      .map(key => key.slice(messagePrefix.length))
      .filter(id => !jobs.has(id));
    this.commit([
      write(metaKey, metadata),
      write(outboxKey, { chats, messages }),
      write(heldKey, {}),
      write(cursorKey, 0),
    ]);
  }

  private replayJournal(): void {
    const journal = this.storage.getString(journalKey);
    if (journal !== undefined) this.apply(decodeJson(journalSchema, journal));
    this.halfAppliedJournal = false;
  }

  private readAfterJournal(key: string): string | undefined {
    if (this.staged?.has(key)) return this.staged.get(key) ?? undefined;
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
    if (this.staged)
      for (const change of writes) this.staged.set(change.key, change.value);
    else if (writes.length === 1) this.writeOneKey(writes[0]);
    else this.writeJournaled(writes);
  }

  private commitMarked(writes: Write[]): void {
    this.commit(writes);
    if (writes.some(change => change.key === outboxKey)) this.onDirty();
  }

  // Every commit inside body lands in one journaled write, or none does.
  private inOneCommit<T>(body: () => T): T {
    const staged = new Map<string, string | null>();
    this.staged = staged;
    let result: T;
    try {
      result = body();
    } finally {
      this.staged = null;
    }
    if (staged.size > 0)
      this.writeJournaled([...staged].map(([key, value]) => ({ key, value })));
    return result;
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

  private read<T>(
    key: string,
    schema: Pick<z.ZodType<T>, 'parse'>,
    absent: T,
  ): T {
    const raw = this.readAfterJournal(key);
    return raw === undefined ? absent : decodeJson(schema, raw);
  }

  children(chatId: string, parentId: string | null): string[] {
    return this.read(childrenKey(chatId, parentId), z.array(idSchema), []);
  }

  private selected(chatId: string, parentId: string | null): string | null {
    return this.read(selectedKey(chatId, parentId), idSchema, null);
  }

  recents(): ChatRecord[] {
    const chats: ChatRecord[] = [];
    for (const id of this.metadata().chatIds) {
      const chat = this.chat(id);
      if (chat.leafId) chats.push(chat);
    }
    return chats.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  createChat(firstPicker: Picker): ChatRecord {
    const meta = this.metadata();
    const current = meta.currentChatId ? this.chat(meta.currentChatId) : null;
    const chat: ChatRecord = {
      version: 1,
      id: this.uuid(),
      title: 'New chat',
      picker: current?.picker ?? firstPicker,
      level: current?.level,
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
  // A level means something different on each model, so a new pick drops it.
  setPicker(id: string, picker: Picker): void {
    this.saveChat({ ...this.chat(id), picker, level: undefined }, 'model');
  }
  setLevel(id: string, level: LevelKey): void {
    this.saveChat({ ...this.chat(id), level }, 'model');
  }
  rename(id: string, title: string): void {
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > 120)
      throw new Error('Use a name between 1 and 120 characters.');
    this.saveChat({ ...this.chat(id), title: trimmed }, 'title');
  }

  // A chat with no turn yet stays on this phone; its first turn sends it all.
  private saveChat(chat: ChatRecord, field: ChatField): void {
    this.commitMarked([
      write(chatKey(chat.id), chat),
      ...(chat.leafId ? [this.marked({ [chat.id]: [field] }, [])] : []),
    ]);
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
      level: chat.level,
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
    // The first turn sends every field, so a picker chosen before it arrives too.
    const fields: ChatField[] = chat.leafId ? ['leaf'] : [...allFields];
    this.commitMarked([
      ...this.addChild(user),
      ...this.addChild(reply),
      write(chatKey(chatId), {
        ...chat,
        title,
        leafId: reply.id,
        updatedAt: this.now(),
      }),
      write(metaKey, { ...meta, jobIds: [...meta.jobIds, reply.id] }),
      this.marked({ [chatId]: fields }, [user.id]),
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
    reply.level = previous.level;
    reply.retryModel = known;
    const meta = this.metadata();
    this.commitMarked([
      ...this.addChild(reply),
      write(chatKey(chat.id), {
        ...chat,
        leafId: reply.id,
        updatedAt: this.now(),
      }),
      write(metaKey, { ...meta, jobIds: [...meta.jobIds, reply.id] }),
      this.marked({ [chat.id]: ['leaf'] }, []),
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
    this.commitMarked([
      write(selectedKey(reply.chatId, reply.parentId), id),
      write(chatKey(reply.chatId), {
        ...this.chat(reply.chatId),
        leafId: leaf.id,
      }),
      this.marked({ [reply.chatId]: ['leaf'] }, []),
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
      ...(reply.level === undefined ? {} : { level: reply.level }),
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

  // Every reply leaves jobIds here, settled, so this is where it is queued.
  acknowledge(id: string): void {
    const message = this.message(id);
    const meta = this.metadata();
    this.commitMarked([
      write(messageKey(id), { ...message, acknowledged: true }),
      write(metaKey, {
        ...meta,
        jobIds: meta.jobIds.filter(job => job !== id),
      }),
      this.marked({}, [id]),
    ]);
  }

  draft(chatId: string): string {
    return this.read(draftKey(chatId), z.string(), '');
  }

  saveDraft(chatId: string, text: string): void {
    this.writeOneKey(
      text === ''
        ? { key: draftKey(chatId), value: null }
        : write(draftKey(chatId), text),
    );
  }

  catalog(): Catalog {
    return (
      parseCatalog(this.storage.getString(catalogKey) ?? '') ?? bakedCatalog
    );
  }

  saveCatalog(body: string): void {
    this.storage.set(catalogKey, body);
  }

  deleteChat(id: string): void {
    this.chat(id);
    this.removeChat(id, true);
  }

  // Walks children/ from the root and never reads the chat record, which a
  // pulled tombstone may name before the record ever arrived.
  private removeChat(id: string, tombstone: boolean): void {
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
    const held = Object.fromEntries(
      Object.entries(this.held()).filter(([chatId]) => chatId !== id),
    );
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
        deletions: tombstone
          ? [...new Set([...meta.deletions, id])]
          : meta.deletions,
      }),
      this.unmarked([id], messageIds),
      write(heldKey, held),
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

  cursor(): number {
    return this.read(cursorKey, seqSchema, 0);
  }

  private outbox(): Outbox {
    return this.read(outboxKey, outboxSchema, { chats: {}, messages: [] });
  }

  private held(): Record<string, ChatRow> {
    return this.read(heldKey, z.record(idSchema, chatRowSchema), {});
  }

  private marked(chats: Outbox['chats'], messages: string[]): Write {
    const outbox = this.outbox();
    const merged = { ...outbox.chats };
    for (const [id, fields] of Object.entries(chats))
      merged[id] = [...new Set([...(merged[id] ?? []), ...fields])];
    return write(outboxKey, {
      chats: merged,
      messages: [...new Set([...outbox.messages, ...messages])],
    });
  }

  private unmarked(chatIds: Iterable<string>, messageIds: Set<string>): Write {
    const outbox = this.outbox();
    const chats = { ...outbox.chats };
    for (const id of chatIds) delete chats[id];
    return write(outboxKey, {
      chats,
      messages: outbox.messages.filter(id => !messageIds.has(id)),
    });
  }

  // Rows are built from the records as they are now. Messages go first, so a
  // chat's leaf reaches the server no later than the chat row.
  outboxBatch(maxBytes = pushBytes): SyncPush | null {
    const outbox = this.outbox();
    const batch: SyncPush = { chats: [], messages: [] };
    const refused: string[] = [];
    let bytes = 0;
    let full = false;
    const take = <T extends MessageRow | ChatRow>(
      id: string,
      row: T | null,
    ): T | null => {
      const size = row ? bytesOf(row) : Number.POSITIVE_INFINITY;
      if (size > maxBytes) refused.push(id);
      else if (bytes + size > maxBytes) full = true;
      else {
        bytes += size;
        return row;
      }
      return null;
    };
    for (const id of outbox.messages) {
      if (full || batch.messages.length === pushMessages) break;
      const row = take(id, messageRow(this.message(id)));
      if (row) batch.messages.push(row);
    }
    for (const [id, dirty] of Object.entries(outbox.chats)) {
      if (full || batch.chats.length === pushChats) break;
      const row = take(id, chatRow(this.chat(id), dirty));
      if (row) batch.chats.push(row);
    }
    if (refused.length > 0)
      this.commit([
        this.unmarked(refused, new Set(refused)),
        write(unsyncedKey, [...this.unsynced(), ...refused]),
      ]);
    return batch.messages.length + batch.chats.length > 0 ? batch : null;
  }

  private unsynced(): string[] {
    return this.read(unsyncedKey, z.array(idSchema), []);
  }

  // A field edited while the batch was in flight stays queued.
  clearPushed(batch: SyncPush): void {
    const outbox = this.outbox();
    const chats = { ...outbox.chats };
    for (const row of batch.chats) {
      const chat = this.hasChat(row.id) ? this.chat(row.id) : null;
      const left = (chats[row.id] ?? []).filter(
        field =>
          chat !== null &&
          !(row.dirty.includes(field) && fieldHolds[field](chat, row)),
      );
      if (left.length > 0) chats[row.id] = left;
      else delete chats[row.id];
    }
    const pushed = new Set(batch.messages.map(row => row.id));
    this.commit([
      write(outboxKey, {
        chats,
        messages: outbox.messages.filter(id => !pushed.has(id)),
      }),
    ]);
  }

  applyRemote(page: SyncPage): RemoteChange {
    return this.inOneCommit(() => {
      const jobs = new Set(this.metadata().jobIds);
      const pulled = page.messages.filter(row => !jobs.has(row.id));
      for (const row of pulled) this.receiveMessage(row);
      const queued = new Set(this.outbox().messages);
      if (pulled.some(row => queued.has(row.id)))
        this.commit([this.unmarked([], new Set(pulled.map(row => row.id)))]);
      for (const id of page.deletedChatIds) this.removeChat(id, false);
      const held = { ...this.held() };
      for (const row of page.chats) held[row.id] = row;
      const chats = new Set<string>();
      for (const row of Object.values(held))
        if (this.receiveChat(row, chats)) delete held[row.id];
      this.commit([write(heldKey, held), write(cursorKey, page.cursor)]);
      return { chats, deleted: page.deletedChatIds };
    });
  }

  // Replies this phone is still settling belong to the session, so the
  // caller skips them. A known message takes the server's outcome and keeps
  // its local images.
  private receiveMessage(row: MessageRow): void {
    if (this.readAfterJournal(messageKey(row.id)) !== undefined) {
      const local = this.message(row.id);
      if (
        local.status === row.status &&
        local.text === row.text &&
        local.reasoning === row.reasoning &&
        local.actualModel === row.actualModel &&
        local.error === row.error
      )
        return;
      this.commit([
        write(messageKey(row.id), {
          ...local,
          status: row.status,
          text: row.text,
          reasoning: row.reasoning,
          actualModel: row.actualModel,
          error: row.error,
        }),
      ]);
      return;
    }
    const settled = row.role === 'assistant';
    const message: SavedMessage = {
      version: 1,
      id: row.id,
      chatId: row.chatId,
      parentId: row.parentId,
      pathId: row.pathId,
      role: row.role,
      text: row.text,
      images: [],
      createdAt: row.createdAt,
      status: row.status,
      picker: row.picker,
      level: row.level,
      retryModel: row.retryModel,
      actualModel: row.actualModel,
      accepted: settled,
      acknowledged: settled,
      sequence: 0,
      cancelPending: false,
      error: row.error,
      reasoning: row.reasoning,
      checkpoint: null,
    };
    const siblings = this.children(row.chatId, row.parentId);
    this.commit([
      write(messageKey(row.id), message),
      ...(siblings.includes(row.id)
        ? []
        : [
            write(childrenKey(row.chatId, row.parentId), [...siblings, row.id]),
          ]),
      ...(this.selected(row.chatId, row.parentId)
        ? []
        : [write(selectedKey(row.chatId, row.parentId), row.id)]),
    ]);
  }

  // Fields still queued here keep their local values. Returns false while the
  // leaf's path is incomplete on this phone, so the row stays held.
  private receiveChat(row: ChatRow, changed: Set<string>): boolean {
    const local = this.hasChat(row.id) ? this.chat(row.id) : null;
    const dirty = new Set(local ? this.outbox().chats[row.id] : []);
    const pick = (field: ChatField) =>
      local && dirty.has(field) ? local : row;
    const model = pick('model');
    const leaf = pick('leaf');
    const chat: ChatRecord = {
      version: 1,
      id: row.id,
      title: pick('title').title,
      picker: model.picker,
      level: model.level,
      createdAt: local?.createdAt ?? row.createdAt,
      updatedAt: leaf.updatedAt,
      basePathId: row.basePathId,
      leafId: leaf.leafId,
    };
    if (chat.leafId !== local?.leafId) {
      let path: SavedMessage[];
      try {
        path = this.ancestry(chat.leafId);
      } catch {
        return false;
      }
      this.commit(
        path.map(message =>
          write(selectedKey(chat.id, message.parentId), message.id),
        ),
      );
    }
    if (local && allFields.every(field => fieldHolds[field](local, chat)))
      return true;
    const meta = this.metadata();
    this.commit([
      write(chatKey(chat.id), chat),
      ...(local
        ? []
        : [write(metaKey, { ...meta, chatIds: [...meta.chatIds, chat.id] })]),
    ]);
    changed.add(chat.id);
    return true;
  }
}
