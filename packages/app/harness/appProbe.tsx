// App probe. Served only by tools/native-transport/app-metro.config.cjs in place
// of index.js. It hides development toasts so screenshots show only app screens
// and reports to the local app server:
// - launch: the moment the boot splash is gone, which happens when the
//   chat screen first draws (the driver compares it with its own launch time);
// - reply: from the user turn appearing to the first reply text, and the
//   interval between text commits while the reply streams;
// - frames: JS frame intervals, every two seconds.
// The launch argument `-harnessSeed recents` saves chats that match the old
// mocked Recents rows; `-harnessSeed long` saves one chat of 1,200 messages.
// The launch argument `-harnessStallOnHide <ms>` blocks the JS thread for
// <ms> on the first keyboard hide after launch, which is the first send, and
// reports how long it blocked.
import React from 'react';
import { AppRegistry, LogBox, Settings } from 'react-native';
import BootSplash from 'react-native-bootsplash';
import { KeyboardEvents } from 'react-native-keyboard-controller';
import performance from 'react-native-performance';
import { sessionTokenSchema } from '../../../shared/contracts';
import App from '../App';
import { name as appName } from '../app.json';
import type { Account } from '../src/account';
import { startAppSession } from '../src/state/appSession';
import type { ChatStore } from '../src/state/chatView';
import { openArchive } from '../src/state/nativeArchive';
import { longTurns, seedChat } from './seed';

LogBox.ignoreAllLogs();

const harnessAccount: Account = {
  appleUserId: 'app-harness-user',
  token: sessionTokenSchema.parse('app-harness-session'.padEnd(43, '0')),
};
AppRegistry.registerComponent(appName, () => () => (
  <App harnessAccount={harnessAccount} />
));

function mockedRecents(): [string, Date][] {
  const today = new Date();
  const daysAgo = (days: number, minute: number) =>
    new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - days,
      12,
      minute,
    );
  return [
    ['Explaining the Fourier transform', daysAgo(3, 3)],
    ['Debugging a Reanimated layout jump', daysAgo(3, 2)],
    ['Weekend trip ideas near Lisbon', daysAgo(3, 1)],
    ['Rewriting a cover letter', daysAgo(4, 2)],
    ['Sourdough starter troubleshooting', daysAgo(4, 1)],
    ['Who founded Margelo?', new Date(2025, 10, 22, 12)],
    ['What does Margelo do?', new Date(2025, 10, 20, 12)],
    ['Margelo open-source libraries', new Date(2025, 9, 26, 12)],
    ['How the Nitro modules work', new Date(2025, 9, 24, 12)],
  ];
}

type SeedKind = 'recents' | 'long';

function seedKind(): SeedKind | undefined {
  const value: unknown = Settings.get('harnessSeed');
  return value === 'recents' || value === 'long' ? value : undefined;
}

function seed(kind: SeedKind | undefined) {
  let clock = Date.now();
  const archive = openArchive(() => clock);
  if (archive.metadata().chatIds.length > 0) return;
  if (kind === 'long') seedChat(archive, longTurns(600));
  if (kind !== 'recents') return;
  for (const [title, updated] of mockedRecents().reverse()) {
    clock = updated.getTime();
    seedChat(archive, [{ question: title, answer: 'Seeded reply.' }]);
  }
  clock = Date.now();
  archive.createChat('auto');
}
seed(seedKind());

const reportUrl = 'http://localhost:8794/harness/report';
type Quantiles = { count: number; p50: number; p95: number; max: number };
type Report =
  | { kind: 'launch' }
  | {
      kind: 'reply';
      status: string;
      firstTextMs: number | null;
      streamMs: number | null;
      chars: number;
      commits: Quantiles;
    }
  | ({ kind: 'frames'; over20: number } & Quantiles)
  | { kind: 'stall'; ms: number };

function post(body: Report) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  void fetch(reportUrl, {
    method: 'POST',
    body: JSON.stringify({ at: Date.now(), ...body }),
    signal: controller.signal,
  })
    .catch(() => undefined)
    .finally(() => clearTimeout(timer));
}

function stallOnHideMs(): number | undefined {
  const value: unknown = Settings.get('harnessStallOnHide');
  const ms = Number(value);
  return Number.isInteger(ms) && ms > 0 ? ms : undefined;
}

const stallMs = stallOnHideMs();
if (stallMs !== undefined) {
  const subscription = KeyboardEvents.addListener('keyboardWillHide', () => {
    subscription.remove();
    const start = Date.now();
    let elapsed = 0;
    while (elapsed < stallMs) elapsed = Date.now() - start;
    post({ kind: 'stall', ms: elapsed });
  });
}

function quantiles(values: number[]): Quantiles {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) };
}

function watchReplies(store: ChatStore) {
  let sentAt: number | null = null;
  let firstText: number | null = null;
  let lastCommit = 0;
  let lastText = '';
  let commits: number[] = [];
  let users = store.getState().messages.filter(m => m.role === 'user').length;
  store.subscribe(() => {
    const { messages } = store.getState();
    const now = performance.now();
    const userCount = messages.filter(m => m.role === 'user').length;
    if (userCount > users) {
      users = userCount;
      sentAt = now;
      firstText = null;
      lastText = '';
      commits = [];
    }
    const reply = messages.at(-1);
    if (sentAt === null || !reply || reply.role !== 'assistant') return;
    if (reply.text !== lastText) {
      if (firstText === null) firstText = now;
      else commits.push(now - lastCommit);
      lastCommit = now;
      lastText = reply.text;
    }
    if (reply.status !== 'streaming') {
      post({
        kind: 'reply',
        status: reply.status,
        firstTextMs: firstText === null ? null : firstText - sentAt,
        streamMs: firstText === null ? null : lastCommit - firstText,
        chars: reply.text.length,
        commits: quantiles(commits),
      });
      sentAt = null;
    }
  });
}

let launchReported = false;
let intervals: number[] = [];
let last = 0;
let windowStart = Date.now();
function frame(time: number) {
  if (!launchReported && !BootSplash.isVisible()) {
    launchReported = true;
    post({ kind: 'launch' });
    startAppSession(harnessAccount.token).then(watchReplies, () => undefined);
  }
  if (last) intervals.push(time - last);
  last = time;
  if (Date.now() - windowStart >= 2000) {
    post({
      kind: 'frames',
      ...quantiles(intervals),
      over20: intervals.filter(value => value > 20).length,
    });
    intervals = [];
    windowStart = Date.now();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
