import type { ChatRecord } from '../src/state/archive';
import { filterRecents, recentTime } from '../src/state/recents';

const now = new Date(2026, 9, 1, 0, 0, 30).getTime();

test.each([
  ['at midnight today', 'Today', new Date(2026, 9, 1, 0, 0, 0)],
  ['one second before midnight', '1d ago', new Date(2026, 8, 30, 23, 59, 59)],
  ['early yesterday', '1d ago', new Date(2026, 8, 30, 0, 0, 0)],
  ['three days ago', '3d ago', new Date(2026, 8, 28, 12)],
  [
    'at the start of the sixth day back',
    '6d ago',
    new Date(2026, 8, 25, 0, 0, 0),
  ],
  [
    'at the end of the seventh day back',
    '7d ago',
    new Date(2026, 8, 24, 23, 59, 59),
  ],
  [
    'at the start of the seventh day back',
    '7d ago',
    new Date(2026, 8, 24, 0, 0, 0),
  ],
  [
    'at the end of the eighth day back',
    'Sep 23, 2026',
    new Date(2026, 8, 23, 23, 59, 59),
  ],
  ['last year', 'Nov 22, 2025', new Date(2025, 10, 22, 18)],
  ['ahead of this clock', 'Today', new Date(2026, 9, 2, 8)],
])('a chat updated %s shows "%s"', (_label, shown, updated) => {
  expect(recentTime(updated.getTime(), now)).toBe(shown);
});

test('a chat from late today still shows "Today" just before midnight', () => {
  const late = new Date(2026, 9, 1, 23, 59, 59).getTime();
  expect(recentTime(new Date(2026, 9, 1, 0, 0, 1).getTime(), late)).toBe(
    'Today',
  );
  expect(recentTime(new Date(2026, 8, 30, 23, 59, 59).getTime(), late)).toBe(
    '1d ago',
  );
});

const titles = [
  'Explaining the Fourier transform',
  'Weekend trip ideas near Lisbon',
  'Sourdough starter troubleshooting',
  'Who founded Margelo?',
  'Margelo open-source libraries',
];
const chats = titles.map((title, index): ChatRecord => ({
  version: 1,
  id: `00000000-0000-4000-8000-00000000000${index}`,
  title,
  picker: 'auto',
  createdAt: index,
  updatedAt: index,
  basePathId: '00000000-0000-4000-8000-000000000100',
  leafId: '00000000-0000-4000-8000-000000000200',
}));
const shown = (query: string) =>
  filterRecents(chats, query).map(chat => chat.title);

test('an empty or blank search keeps every chat in recents order', () => {
  expect(filterRecents(chats, '')).toBe(chats);
  expect(filterRecents(chats, '   ')).toBe(chats);
});

test('a search keeps the titles that match anywhere, best match first, and tolerates a typo', () => {
  expect(shown('lisbon')).toEqual(['Weekend trip ideas near Lisbon']);
  expect(shown('sourdugh')).toEqual(['Sourdough starter troubleshooting']);
  expect(shown('margelo')).toEqual([
    'Who founded Margelo?',
    'Margelo open-source libraries',
  ]);
  expect(shown('quantum')).toEqual([]);
});
