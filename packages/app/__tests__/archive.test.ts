import {
  ChatArchive,
  type ArchiveStorage,
  type SavedMessage,
} from '../src/state/archive';

let fixtureId = 0;
function randomUUID(): string {
  fixtureId += 1;
  return `00000000-0000-4000-8000-${fixtureId.toString(16).padStart(12, '0')}`;
}

class MemoryStorage implements ArchiveStorage {
  readonly values = new Map<string, string>();
  failAfter: number | null = null;
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
  const a = archive.createChat();
  expect(archive.recents()).toHaveLength(0);
  archive.setPicker(a.id, 'gpt-6.1-sol');
  const aReply = archive.createTurn(a.id, 'Chat A', []);
  const b = archive.createChat();
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

test('retry versions preserve both continuations and restore the selected path', () => {
  const archive = new ChatArchive(new MemoryStorage(), randomUUID);
  const chat = archive.createChat();
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
  const a = archive.createChat();
  const first = archive.createTurn(a.id, 'A', []);
  expect(() => archive.createTurn(a.id, 'Queued', [])).toThrow(
    'Wait for this reply',
  );
  const b = archive.createChat();
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
  const chat = archive.createChat();
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
  const kept = archive.createChat();
  const deleted = archive.createChat();
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
  const chat = archive.createChat();
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
  const chat = archive.createChat();
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
  const chat = archive.createChat();
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
  const chat = archive.createChat();
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
