import type { SavedMessage } from '../src/state/archive';
import { toMessage, type MessageStatus } from '../src/state/chatView';
import type { AttemptActivity } from '../src/state/session';

const reply: SavedMessage = {
  version: 1,
  id: '00000000-0000-4000-8000-000000000002',
  chatId: '00000000-0000-4000-8000-000000000010',
  parentId: '00000000-0000-4000-8000-000000000001',
  pathId: '00000000-0000-4000-8000-000000000011',
  role: 'assistant',
  text: 'Partial',
  images: [],
  createdAt: 1,
  status: 'generating',
  picker: 'kimi',
  retryModel: null,
  actualModel: 'kimi',
  accepted: true,
  acknowledged: false,
  sequence: 3,
  cancelPending: false,
  error: null,
  reasoning: '',
  checkpoint: null,
};
const idle: AttemptActivity = { kind: 'idle' };

test.each<[SavedMessage['status'], MessageStatus]>([
  ['pending', 'streaming'],
  ['accepted', 'streaming'],
  ['selecting', 'streaming'],
  ['compacting', 'streaming'],
  ['generating', 'streaming'],
  ['completed', 'done'],
  ['stopped', 'done'],
  ['deleted', 'done'],
  ['failed', 'error'],
  ['interrupted', 'error'],
])('a %s reply shows as %s with its text', (status, shown) => {
  expect(toMessage({ ...reply, status }, idle)).toEqual({
    id: reply.id,
    role: 'assistant',
    text: 'Partial',
    status: shown,
    reasoning: undefined,
  });
});

test('a halted reply shows the error line even while its saved status is still running', () => {
  const halted: AttemptActivity = { kind: 'halted', error: 'Storage failed.' };
  expect(toMessage(reply, halted).status).toBe('error');
  const waiting: AttemptActivity = { kind: 'waiting', error: 'Offline.' };
  expect(toMessage(reply, waiting).status).toBe('streaming');
});

test('saved reasoning reaches the trace, and a user turn keeps the images picked in this process', () => {
  expect(toMessage({ ...reply, reasoning: 'Step one' }, idle).reasoning).toBe(
    'Step one',
  );
  const files = ['file:///photo.jpg'];
  expect(
    toMessage(
      { ...reply, role: 'user', status: 'completed', text: 'Look' },
      idle,
      files,
    ),
  ).toEqual({
    id: reply.id,
    role: 'user',
    text: 'Look',
    status: 'done',
    attachments: files,
  });
});
