import { bakedCatalog } from '../../../shared/catalog';
import type { SyncPage, SyncPush } from '../../../shared/contracts';
import {
  ChatArchive,
  ownerStorage,
  type ArchiveStorage,
  type SavedMessage,
} from '../src/state/archive';

let fixtureId = 0;
function randomUUID(): string {
  fixtureId += 1;
  return `00000000-0000-4000-8000-${fixtureId.toString(16).padStart(12, '0')}`;
}

class MemoryStorage implements ArchiveStorage {
  readonly values: Map<string, string>;
  failAfter: number | null = null;
  constructor(values = new Map<string, string>()) {
    this.values = new Map(values);
  }
  getString(key: string) {
    return this.values.get(key);
  }
  getAllKeys() {
    return [...this.values.keys()];
  }
  set(key: string, value: string) {
    if (this.failAfter === 0) {
      this.failAfter = null;
      throw new Error('Simulated termination');
    }
    if (this.failAfter !== null) this.failAfter -= 1;
    this.values.set(key, value);
  }
  remove(key: string) {
    this.values.delete(key);
  }
}

function complete(
  archive: ChatArchive,
  message: SavedMessage,
  text = 'A reply',
): void {
  archive.saveMessages([
    {
      ...message,
      status: 'completed',
      text,
      actualModel: 'kimi',
      accepted: true,
    },
  ]);
  archive.acknowledge(message.id);
}

test('new chats inherit then independently remember the current picker across restart', () => {
  const storage = new MemoryStorage();
  const archive = new ChatArchive(storage, randomUUID);
  archive.recover();
  const a = archive.createChat('deepseek');
  expect(a.picker).toBe('deepseek');
  expect(archive.recents()).toHaveLength(0);
  archive.setPicker(a.id, 'gpt-6.1-sol');
  const aReply = archive.createTurn(a.id, 'Chat A', []);
  const b = archive.createChat('deepseek');
  expect(b.picker).toBe('gpt-6.1-sol');
  archive.setPicker(b.id, 'kimi');
  const bReply = archive.createTurn(b.id, 'Chat B', []);
  const restored = new ChatArchive(storage, randomUUID);
  restored.recover();
  expect(restored.chat(a.id).picker).toBe('gpt-6.1-sol');
  expect(restored.chat(b.id).picker).toBe('kimi');
  expect(restored.pendingJobs().map(job => job.id)).toEqual([
    aReply.id,
    bReply.id,
  ]);
  expect(restored.submission(aReply.id).history[0].text).toBe('Chat A');
  expect(restored.submission(bReply.id).history[0].text).toBe('Chat B');
});

test('a chat level persists, rides each reply and its retry, and a new model drops it', () => {
  const storage = new MemoryStorage();
  const archive = new ChatArchive(storage, randomUUID);
  archive.recover();
  const chat = archive.createChat('gpt-6.1-sol');
  const plain = archive.createTurn(chat.id, 'At the default level', []);
  expect(storage.values.get(`archive/chat/${chat.id}`)).not.toContain(
    '"level"',
  );
  expect(storage.values.get(`archive/message/${plain.id}`)).not.toContain(
    '"level"',
  );
  expect(archive.submission(plain.id)).not.toHaveProperty('level');
  complete(archive, plain);

  archive.setLevel(chat.id, 'high');
  const restored = new ChatArchive(storage, randomUUID);
  restored.recover();
  expect(restored.chat(chat.id).level).toBe('high');
  const reply = restored.createTurn(chat.id, 'At high', []);
  expect(restored.submission(reply.id).level).toBe('high');
  complete(restored, reply);
  restored.setLevel(chat.id, 'low');
  const retry = restored.retry(reply.id);
  expect(restored.submission(retry.id)).toMatchObject({
    retryModel: 'kimi',
    level: 'high',
  });

  const next = restored.createChat('deepseek');
  expect(next).toMatchObject({ picker: 'gpt-6.1-sol', level: 'low' });
  restored.setPicker(next.id, 'gpt-6-astra');
  expect(restored.chat(next.id)).not.toHaveProperty('level');
  expect(storage.values.get(`archive/chat/${next.id}`)).not.toContain(
    '"level"',
  );
});

test('retry versions preserve both continuations and restore the selected path', () => {
  const archive = new ChatArchive(new MemoryStorage(), randomUUID);
  const chat = archive.createChat('auto');
  const first = archive.createTurn(chat.id, 'Original question', []);
  complete(archive, first, 'Version one');
  const oldContinuation = archive.createTurn(chat.id, 'Follow version one', []);
  complete(archive, oldContinuation, 'Old continuation');
  const retry = archive.retry(first.id);
  expect(retry.retryModel).toBe('kimi');
  expect(
    archive.submission(retry.id).history.map(message => message.text),
  ).toEqual(['Original question']);
  complete(archive, retry, 'Version two');
  const newContinuation = archive.createTurn(chat.id, 'Follow version two', []);
  complete(archive, newContinuation, 'New continuation');
  archive.selectVersion(first.id);
  expect(archive.chat(chat.id).leafId).toBe(oldContinuation.id);
  expect(
    archive.ancestry(archive.chat(chat.id).leafId).map(message => message.text),
  ).toEqual([
    'Original question',
    'Version one',
    'Follow version one',
    'Old continuation',
  ]);
  archive.selectVersion(retry.id);
  expect(archive.chat(chat.id).leafId).toBe(newContinuation.id);
  expect(archive.children(chat.id, first.parentId)).toEqual([
    first.id,
    retry.id,
  ]);
});

test('only the busy path is blocked and partial answers are marked incomplete in later context', () => {
  const archive = new ChatArchive(new MemoryStorage(), randomUUID);
  const a = archive.createChat('auto');
  const first = archive.createTurn(a.id, 'A', []);
  expect(() => archive.createTurn(a.id, 'Queued', [])).toThrow(
    'Wait for this reply',
  );
  const b = archive.createChat('auto');
  expect(archive.createTurn(b.id, 'B', []).chatId).toBe(b.id);
  archive.saveMessages([
    {
      ...first,
      text: 'Partial answer',
      status: 'stopped',
      actualModel: 'gpt-6.1-sol',
    },
  ]);
  const next = archive.createTurn(a.id, 'Continue', []);
  expect(archive.submission(next.id).history[1]).toMatchObject({
    text: 'Partial answer',
    complete: false,
  });
});

test('the write journal restores a send interrupted between message and index writes', () => {
  const storage = new MemoryStorage();
  const archive = new ChatArchive(storage, randomUUID);
  const chat = archive.createChat('auto');
  storage.failAfter = 3;
  expect(() => archive.createTurn(chat.id, 'Saved before sending', [])).toThrow(
    'Simulated termination',
  );
  const restored = new ChatArchive(storage, randomUUID);
  restored.recover();
  const [job] = restored.pendingJobs();
  expect(restored.submission(job.id).history[0].text).toBe(
    'Saved before sending',
  );
  expect(restored.ancestry(restored.chat(chat.id).leafId)).toHaveLength(2);
  expect(storage.getString('archive/journal')).toBeUndefined();
});

test('a save that fails partway is completed before the next save, so a later write cannot strand it', () => {
  const storage = new MemoryStorage();
  const archive = new ChatArchive(storage, randomUUID);
  const kept = archive.createChat('auto');
  const deleted = archive.createChat('auto');
  complete(archive, archive.createTurn(deleted.id, 'Delete me', []));
  storage.failAfter = 1;
  expect(() => archive.deleteChat(deleted.id)).toThrow('Simulated termination');
  archive.rename(kept.id, 'Kept');
  const restored = new ChatArchive(storage, randomUUID);
  restored.recover();
  expect(restored.metadata()).toMatchObject({
    chatIds: [kept.id],
    deletions: [deleted.id],
  });
  expect(restored.chat(kept.id).title).toBe('Kept');
});

test('unsupported or corrupt records are preserved and cannot silently become empty chats', () => {
  const storage = new MemoryStorage();
  storage.values.set('archive/index', '{"version":99}');
  const before = [...storage.values];
  const archive = new ChatArchive(storage, randomUUID);
  expect(() => archive.recover()).toThrow();
  expect([...storage.values]).toEqual(before);
  storage.values.delete('archive/index');
  storage.values.set('archive/message/example', 'preserve this data');
  expect(() => archive.recover()).toThrow('index is missing');
  expect(storage.values.get('archive/message/example')).toBe(
    'preserve this data',
  );
});

test('history beyond 500 messages remains stored while the visible window can be paged', () => {
  const archive = new ChatArchive(new MemoryStorage(), randomUUID);
  const chat = archive.createChat('auto');
  for (let index = 0; index < 255; index += 1) {
    const reply = archive.createTurn(chat.id, `Question ${index}`, []);
    complete(archive, reply);
  }
  const leaf = archive.chat(chat.id).leafId;
  const latest = archive.ancestry(leaf, 100);
  expect(latest.map(message => message.text).slice(0, 2)).toEqual([
    'Question 205',
    'A reply',
  ]);
  expect(latest.at(-1)?.id).toBe(leaf);
  const older = archive.ancestry(latest[0].parentId, 100);
  expect(older.at(-1)?.text).toBe('A reply');
  expect(older[0].text).toBe('Question 155');
  expect(archive.ancestry(leaf)).toHaveLength(510);
  expect(archive.ancestry(leaf)[0].text).toBe('Question 0');
});

test('Delete removes every version and keeps a pending server tombstone across restart', () => {
  const storage = new MemoryStorage();
  const archive = new ChatArchive(storage, randomUUID);
  const chat = archive.createChat('auto');
  const first = archive.createTurn(chat.id, 'A question', []);
  complete(archive, first);
  const second = archive.retry(first.id);
  archive.deleteChat(chat.id);
  const restored = new ChatArchive(storage, randomUUID);
  restored.recover();
  expect(restored.recents()).toEqual([]);
  expect(restored.pendingJobs()).toEqual([]);
  expect(restored.metadata().deletions).toEqual([chat.id]);
  expect(() => restored.message(first.id)).toThrow('missing');
  expect(() => restored.message(second.id)).toThrow('missing');
});

test('a checkpoint after a fork cannot enter a sibling retry or continuation', () => {
  const archive = new ChatArchive(new MemoryStorage(), randomUUID);
  const chat = archive.createChat('auto');
  const first = archive.createTurn(chat.id, 'Question', []);
  complete(archive, first);
  archive.saveMessages([
    {
      ...archive.message(first.id),
      checkpoint: {
        model: 'gpt-6.1-sol',
        throughMessageId: first.id,
        method: 'openai-compaction',
        items: [{ type: 'compaction', encrypted_content: 'only first branch' }],
        summary: '',
      },
    },
  ]);
  const second = archive.retry(first.id);
  expect(archive.submission(second.id).checkpoints).toEqual([]);
  complete(archive, second);
  const continuation = archive.createTurn(chat.id, 'New branch', []);
  expect(archive.submission(continuation.id).checkpoints).toEqual([]);
});

test('Retry reuses a model saved only as a retry model and refuses to swap a known model', () => {
  const archive = new ChatArchive(new MemoryStorage(), randomUUID);
  const chat = archive.createChat('auto');
  const first = archive.createTurn(chat.id, 'Question', []);
  const failed = (message: SavedMessage) => {
    archive.saveMessages([
      { ...message, status: 'failed', accepted: true, error: 'Failed early.' },
    ]);
    archive.acknowledge(message.id);
  };
  failed(first);
  expect(() => archive.retry(first.id)).toThrow(
    'Choose a model for this retry.',
  );
  const second = archive.retry(first.id, 'deepseek');
  failed(second);
  expect(archive.retry(second.id).retryModel).toBe('deepseek');
  expect(() => archive.retry(second.id, 'kimi')).toThrow(
    'This reply already has a model. Retry uses deepseek.',
  );
  expect(archive.retry(second.id, 'deepseek').retryModel).toBe('deepseek');
});

test('a catalog cached before the first chat keeps the archive readable, and a missing or corrupt cache gives the baked catalog', () => {
  const storage = new MemoryStorage();
  const archive = new ChatArchive(storage, randomUUID);
  expect(archive.catalog()).toEqual(bakedCatalog);
  const cached = { auto: false, models: [bakedCatalog.models[2]] };
  archive.saveCatalog(JSON.stringify(cached));
  archive.recover();
  expect(archive.createChat('deepseek').picker).toBe('deepseek');
  expect(new ChatArchive(storage, randomUUID).catalog()).toEqual(cached);
  archive.saveCatalog('{"auto":');
  expect(archive.catalog()).toEqual(bakedCatalog);
});

function opened(storage: ArchiveStorage = new MemoryStorage()): ChatArchive {
  const archive = new ChatArchive(storage, randomUUID);
  archive.recover();
  return archive;
}

// Another phone's chat as the server would return it.
function remoteChat(turns: string[]) {
  const archive = opened();
  const chat = archive.createChat('auto');
  for (const text of turns)
    complete(archive, archive.createTurn(chat.id, text, []));
  const batch = archive.outboxBatch();
  if (!batch) throw new Error('The remote chat queued nothing.');
  return {
    chatId: chat.id,
    rows: {
      chats: batch.chats.map(({ dirty: _dirty, ...row }) => row),
      messages: batch.messages,
    },
  };
}

function page(cursor: number, rows: Partial<SyncPage> = {}): SyncPage {
  return {
    chats: [],
    messages: [],
    deletedChatIds: [],
    more: false,
    cursor,
    ...rows,
  };
}

function pushAll(archive: ChatArchive): SyncPush {
  const batch = archive.outboxBatch();
  if (!batch) throw new Error('Nothing was queued.');
  archive.clearPushed(batch);
  return batch;
}

// Runs act once per write it makes, crashing at that write, then reopens.
function atEveryCrash(
  base: MemoryStorage,
  act: (archive: ChatArchive) => void,
  check: (restored: ChatArchive) => void,
): void {
  for (let writes = 0; ; writes += 1) {
    const storage = new MemoryStorage(base.values);
    const archive = new ChatArchive(storage, randomUUID);
    storage.failAfter = writes;
    let finished = true;
    try {
      act(archive);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'Simulated termination'
      )
        throw error;
      finished = false;
    }
    storage.failAfter = null;
    check(opened(storage));
    if (finished) return;
  }
}

test('a crash while a pulled page is saved never leaves the cursor ahead of its rows', () => {
  const remote = remoteChat(['First', 'Second']);
  const pulled = page(9, remote.rows);
  const base = new MemoryStorage();
  opened(base);
  const outcomes = new Set<string>();
  atEveryCrash(
    base,
    archive => archive.applyRemote(pulled),
    restored => {
      const leaf = restored.hasChat(remote.chatId)
        ? restored.chat(remote.chatId).leafId
        : null;
      outcomes.add(
        JSON.stringify([
          restored.cursor(),
          restored.ancestry(leaf).map(message => message.text),
        ]),
      );
    },
  );
  expect([...outcomes].sort()).toEqual([
    JSON.stringify([0, []]),
    JSON.stringify([9, ['First', 'A reply', 'Second', 'A reply']]),
  ]);
});

test('a send, a rename and a settled reply are queued in the same write as the change', () => {
  const base = new MemoryStorage();
  const archive = opened(base);
  const chat = archive.createChat('auto');
  complete(archive, archive.createTurn(chat.id, 'Before', []));
  const pending = archive.createTurn(chat.id, 'Waiting', []);
  pushAll(archive);
  const queued = (restored: ChatArchive) => {
    const batch = restored.outboxBatch();
    return {
      messages: batch?.messages.map(row => row.id) ?? [],
      fields: batch?.chats.find(row => row.id === chat.id)?.dirty ?? [],
    };
  };

  atEveryCrash(
    base,
    current => {
      current.saveMessages([
        { ...pending, status: 'completed', accepted: true, text: 'Done' },
      ]);
      current.acknowledge(pending.id);
    },
    restored => {
      const left = restored.metadata().jobIds.includes(pending.id);
      expect(queued(restored).messages.includes(pending.id)).toBe(!left);
    },
  );

  complete(archive, pending);
  pushAll(archive);
  atEveryCrash(
    base,
    current => current.rename(chat.id, 'Renamed'),
    restored => {
      const renamed = restored.chat(chat.id).title === 'Renamed';
      expect(queued(restored).fields).toEqual(renamed ? ['title'] : []);
    },
  );

  const leaf = archive.chat(chat.id).leafId;
  atEveryCrash(
    base,
    current => current.createTurn(chat.id, 'Next', []),
    restored => {
      const sent = restored.chat(chat.id).leafId !== leaf;
      const { messages, fields } = queued(restored);
      expect(fields).toEqual(sent ? ['leaf'] : []);
      expect(messages).toHaveLength(sent ? 1 : 0);
    },
  );
});

test('an archive from before sync queues its settled messages and sent chats once, and a new store gets an index', () => {
  const storage = new MemoryStorage();
  const legacy = new ChatArchive(storage, randomUUID);
  const sent = legacy.createChat('auto');
  const settledReply = legacy.createTurn(sent.id, 'Answered', []);
  complete(legacy, settledReply);
  // Finished, but its receipt is not confirmed, so acknowledge queues it later.
  const pending = legacy.createTurn(sent.id, 'Finished, not acknowledged', []);
  legacy.saveMessages([
    { ...pending, status: 'completed', accepted: true, text: 'Done' },
  ]);
  const unsent = legacy.createChat('kimi');
  for (const key of ['archive/outbox', 'archive/sync/cursor'])
    storage.values.delete(key);

  const seeded = opened(storage);
  const first = storage.values.get('archive/outbox');
  const batch = seeded.outboxBatch();
  expect(batch?.chats.map(row => [row.id, row.dirty])).toEqual([
    [sent.id, ['title', 'model', 'leaf']],
  ]);
  expect(batch?.messages.map(row => row.id).sort()).toEqual(
    [settledReply.parentId, settledReply.id, pending.parentId].sort(),
  );
  expect(batch?.messages.map(row => row.id)).not.toContain(pending.id);
  expect(batch?.chats.map(row => row.id)).not.toContain(unsent.id);

  storage.values.delete('archive/sync/cursor');
  opened(storage);
  expect(storage.values.get('archive/outbox')).toBe(first);

  const fresh = new MemoryStorage();
  opened(fresh);
  expect(opened(fresh).metadata().chatIds).toEqual([]);
});

test('a reply the pull returned is not uploaded again', () => {
  const archive = opened();
  const chat = archive.createChat('auto');
  const reply = archive.createTurn(chat.id, 'Question', []);
  complete(archive, reply, 'Local copy');
  const stored = archive
    .outboxBatch()
    ?.messages.find(row => row.id === reply.id);
  if (!stored) throw new Error('The reply was not queued.');
  archive.applyRemote(
    page(3, { messages: [{ ...stored, text: 'Server copy' }] }),
  );
  expect(archive.outboxBatch()?.messages.map(row => row.id)).not.toContain(
    reply.id,
  );
  expect(archive.message(reply.id).text).toBe('Server copy');
});

test('a pulled chat row takes the server title but keeps a model chosen here and not yet sent', () => {
  const archive = opened();
  const chat = archive.createChat('auto');
  complete(archive, archive.createTurn(chat.id, 'Question', []));
  const [row] = pushAll(archive).chats;
  archive.setPicker(chat.id, 'kimi');
  const { dirty: _dirty, ...sent } = row;
  archive.applyRemote(
    page(5, {
      chats: [{ ...sent, title: 'From the other phone', picker: 'deepseek' }],
    }),
  );
  expect(archive.chat(chat.id)).toMatchObject({
    title: 'From the other phone',
    picker: 'kimi',
  });
});

test('a pulled chat waits until its messages arrive in a later page', () => {
  const remote = remoteChat(['Hello']);
  const archive = opened();
  archive.applyRemote(page(1, { chats: remote.rows.chats, more: true }));
  expect(archive.recents()).toEqual([]);
  expect(archive.hasChat(remote.chatId)).toBe(false);
  const change = archive.applyRemote(
    page(3, { messages: remote.rows.messages }),
  );
  expect([...change.chats]).toEqual([remote.chatId]);
  const [restored] = archive.recents();
  expect(restored.id).toBe(remote.chatId);
  expect(
    archive.ancestry(restored.leafId).map(message => message.text),
  ).toEqual(['Hello', 'A reply']);
});

test('a pulled delete removes a chat whose record never arrived', () => {
  const remote = remoteChat(['Gone soon']);
  const storage = new MemoryStorage();
  const archive = opened(storage);
  archive.applyRemote(page(2, { messages: remote.rows.messages }));
  expect(archive.children(remote.chatId, null)).toHaveLength(1);
  const change = archive.applyRemote(
    page(4, { deletedChatIds: [remote.chatId] }),
  );
  expect(change.deleted).toEqual([remote.chatId]);
  const left = [...storage.values.keys()].filter(
    key =>
      key.includes(remote.chatId) ||
      remote.rows.messages.some(row => key.includes(row.id)),
  );
  expect(left).toEqual([]);
  expect(archive.metadata().deletions).toEqual([]);
});

test('a title edited while its push is in flight stays queued', () => {
  const archive = opened();
  const chat = archive.createChat('auto');
  complete(archive, archive.createTurn(chat.id, 'Question', []));
  const batch = archive.outboxBatch();
  if (!batch) throw new Error('Nothing was queued.');
  archive.rename(chat.id, 'Edited during the push');
  archive.clearPushed(batch);
  expect(archive.outboxBatch()).toEqual({
    messages: [],
    chats: [
      expect.objectContaining({
        id: chat.id,
        title: 'Edited during the push',
        dirty: ['title'],
      }),
    ],
  });
});

test("a second Apple user gets an empty store and leaves the first user's chats and queue alone", () => {
  const stores = new Map<string, MemoryStorage>();
  const open = (id: string) => {
    const storage = stores.get(id) ?? new MemoryStorage();
    stores.set(id, storage);
    return storage;
  };
  const first = opened(ownerStorage('001.aaa.1', open));
  const chat = first.createChat('auto');
  complete(first, first.createTurn(chat.id, 'Mine', []));
  const before = new Map(stores.get('personal-chat.archive.v1')?.values);

  const second = opened(ownerStorage('002.bbb.2', open));
  expect(second.recents()).toEqual([]);
  expect(second.outboxBatch()).toBeNull();
  second.createTurn(second.createChat('auto').id, 'Theirs', []);
  expect(stores.get('personal-chat.archive.v1')?.values).toEqual(before);

  const again = opened(ownerStorage('001.aaa.1', open));
  expect(again.recents().map(saved => saved.id)).toEqual([chat.id]);
});
