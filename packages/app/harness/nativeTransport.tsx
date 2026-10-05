// Native transport harness. Served only by tools/native-transport/metro.config.cjs
// in place of index.js; the app's own entry and navigation never import it.
import { useEffect, useState } from 'react';
import 'react-native-get-random-values';
import { AppRegistry, AppState, Settings, Text, View } from 'react-native';
import {
  fetch as nitroFetch,
  NetworkInspector,
} from 'react-native-nitro-fetch';
import type {
  AttemptSnapshot,
  ServerMessage,
  Submission,
} from '../../../shared/contracts';
import faults from '../../../tools/native-transport/faults.json';
import { ServerTransport, type ClientDrivers } from '../src/network/client';
import { nativeDrivers } from '../src/network/nativeDrivers';
import { TransportError } from '../src/network/transport';

const api = `http://localhost:${faults.ports.api}`;
const faultServer = `http://localhost:${faults.ports.fault}`;

const publicNitroFetchDrivers: ClientDrivers = {
  ...nativeDrivers,
  fetch: (url, init) => nitroFetch(url, init),
};

type ErrorReport = { name: string; message?: string; status?: number };
type Settled =
  | { state: 'resolved'; ms: number }
  | { state: 'rejected'; ms: number; error: ErrorReport }
  | { state: 'hung'; ms: number };

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Rejections are untyped; this reduces one to a report.
function describe(error: unknown): ErrorReport {
  if (error instanceof TransportError)
    return {
      name: 'TransportError',
      status: error.status,
      message: error.message,
    };
  if (error instanceof Error)
    return { name: error.name, message: error.message };
  return { name: typeof error };
}

function settle(promise: Promise<unknown>, limitMs: number): Promise<Settled> {
  const started = Date.now();
  return new Promise(resolve => {
    const timer = setTimeout(
      () => resolve({ state: 'hung', ms: Date.now() - started }),
      limitMs,
    );
    promise.then(
      () => {
        clearTimeout(timer);
        resolve({ state: 'resolved', ms: Date.now() - started });
      },
      error => {
        clearTimeout(timer);
        resolve({
          state: 'rejected',
          ms: Date.now() - started,
          error: describe(error),
        });
      },
    );
  });
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Harness control requests go to the local fixture server and must not hang.
function timeout(): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10_000);
  return controller.signal;
}

function uuid(): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const text = `${hex.slice(0, 12)}4${hex.slice(13, 16)}8${hex.slice(17)}`;
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

function submission(): Submission {
  const userTurnId = uuid();
  return {
    version: 1,
    attemptId: uuid(),
    chatId: uuid(),
    pathId: uuid(),
    userTurnId,
    picker: 'kimi',
    retryModel: null,
    history: [
      {
        id: userTurnId,
        parentId: null,
        role: 'user',
        text: 'REQUEST-BODY-MARKER hello',
        images: [],
        complete: true,
      },
    ],
    checkpoints: [],
  };
}

function faultSnapshot(attemptId: string): AttemptSnapshot {
  return {
    version: 1,
    attemptId,
    chatId: '00000000-0000-4000-8000-0000000000c1',
    pathId: '00000000-0000-4000-8000-0000000000c2',
    userTurnId: '00000000-0000-4000-8000-0000000000c3',
    sequence: 0,
    status: 'generating',
    actualModel: 'kimi',
    text: '',
    reasoning: '',
    error: null,
    checkpoint: null,
    cancelRequested: false,
    delivered: false,
  };
}

type Control =
  | { op: 'drop'; when: 'before-accepted' | 'after-accepted' }
  | { op: 'complete'; attemptId: string; text: string };

async function post<Body extends Control | { driver: string }>(
  path: string,
  body: Body,
): Promise<void> {
  await fetch(`${api}${path}`, {
    signal: timeout(),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const report = <Entry extends { driver: string }>(entry: Entry) =>
  post('/harness/report', entry);

async function job(attemptId: string): Promise<{
  snapshot: AttemptSnapshot;
  dispatches: number;
}> {
  return (
    await fetch(`${api}/harness/job/${attemptId}`, { signal: timeout() })
  ).json();
}

function providerText(message: ServerMessage): string | null {
  return message.kind === 'event' && message.event.kind === 'provider'
    ? message.event.raw
    : null;
}

function terminalText(message: ServerMessage): string | null {
  if (message.kind === 'accepted') return message.snapshot.text;
  return message.kind === 'event' && message.event.kind === 'snapshot'
    ? message.event.snapshot.text
    : null;
}

async function run(
  driver: string,
  device: string,
  show: (text: string) => void,
) {
  const drivers = driver === 'draft' ? publicNitroFetchDrivers : nativeDrivers;
  const server = new ServerTransport(api, device, drivers, true);
  const fault = new ServerTransport(faultServer, device, drivers, true);
  const scenario = async (name: string, body: () => Promise<object>) => {
    show(name);
    try {
      await report({ scenario: name, driver, ...(await body()) });
    } catch (error) {
      await report({ scenario: name, driver, harnessError: describe(error) });
    }
  };
  NetworkInspector.enable();
  while (
    (await fetch(`${api}/harness/go`, { signal: timeout() })).status !== 204
  )
    await wait(250);

  for (const kind of ['get', 'watch'] as const)
    await scenario(`abort-before-headers-${kind}`, async () => {
      const controller = new AbortController();
      const pending =
        kind === 'get'
          ? fault.get(faults.hold, controller.signal)
          : fault.watch(
              faultSnapshot(faults.hold),
              () => undefined,
              controller.signal,
            );
      await wait(500);
      controller.abort();
      return { ...(await settle(pending, 5000)) };
    });

  await scenario('abort-during-stream', async () => {
    const controller = new AbortController();
    let received = 0;
    let settled = false;
    let late = 0;
    const pending = fault.watch(
      faultSnapshot(faults.drip),
      () => {
        received += 1;
        if (settled) late += 1;
        if (received === 5) setTimeout(() => controller.abort(), 0);
      },
      controller.signal,
    );
    const outcome = await settle(pending, 8000);
    settled = true;
    const receivedAtSettle = received;
    await wait(1000);
    return {
      ...outcome,
      receivedAtSettle,
      lateReceives: late + received - receivedAtSettle,
    };
  });

  await scenario('detach-real-job-then-stop', async () => {
    const input = submission();
    const controller = new AbortController();
    const kinds: string[] = [];
    const pending = server.submit(
      input,
      message => {
        kinds.push(message.kind);
        if (message.kind === 'accepted')
          setTimeout(() => controller.abort(), 300);
      },
      controller.signal,
    );
    const detach = await settle(pending, 8000);
    await wait(500);
    const afterDetach = await job(input.attemptId);
    const stop = await server.stop(
      input.attemptId,
      new AbortController().signal,
    );
    const afterStop = await job(input.attemptId);
    return {
      attemptId: input.attemptId,
      detach,
      kinds,
      afterDetach: {
        status: afterDetach.snapshot.status,
        cancelRequested: afterDetach.snapshot.cancelRequested,
        dispatches: afterDetach.dispatches,
      },
      stopStatus: stop?.status ?? null,
      afterStop: { cancelRequested: afterStop.snapshot.cancelRequested },
    };
  });

  for (const kind of ['get', 'watch'] as const)
    await scenario(`redirect-${kind}`, async () => {
      const signal = new AbortController().signal;
      const pending =
        kind === 'get'
          ? fault.get(faults.redirect, signal)
          : fault.watch(
              faultSnapshot(faults.redirect),
              () => undefined,
              signal,
            );
      // A busy JS thread, as during rendering, must not let the redirect through.
      const busyUntil = Date.now() + 300;
      while (Date.now() < busyUntil);
      return { ...(await settle(pending, 5000)) };
    });

  await scenario('admission-errors', async () => {
    const results: Record<string, Settled> = {};
    for (const [status, id] of Object.entries(faults.admission))
      results[status] = await settle(
        fault.get(id, new AbortController().signal),
        5000,
      );
    const stranger = new ServerTransport(api, 'x'.repeat(43), drivers, true);
    results.real401 = await settle(
      stranger.get(uuid(), new AbortController().signal),
      5000,
    );
    return { results };
  });

  await scenario('utf8-split', async () => {
    const response = await drivers.fetch(
      `${faultServer}/v1/jobs/${faults.utf8}/events`,
      {
        method: 'GET',
        redirect: 'error',
        stream: true,
        signal: new AbortController().signal,
        headers: { 'X-Device-Id': device },
      },
    );
    const reader = response.body?.getReader();
    let chunks = 0;
    let splitBoundaries = 0;
    for (;;) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done || !chunk.value) break;
      if (
        chunks > 0 &&
        chunk.value.length > 0 &&
        (chunk.value[0] & 0xc0) === 0x80
      )
        splitBoundaries += 1;
      chunks += 1;
    }
    const texts: string[] = [];
    const outcome = await settle(
      fault.watch(
        faultSnapshot(faults.utf8),
        message => {
          const text = providerText(message) ?? terminalText(message);
          if (text) texts.push(text);
        },
        new AbortController().signal,
      ),
      10000,
    );
    return {
      rawChunks: chunks,
      splitBoundaries,
      ...outcome,
      exact:
        texts.length === 2 && texts.every(text => text === faults.utf8Text),
      texts: texts.map(text => text.length),
    };
  });

  for (const [name, id] of [
    ['truncated', faults.truncated],
    ['clean-close-without-terminal', faults.earlyEnd],
    ['malformed-sse', faults.malformed],
  ] as const)
    await scenario(name, async () => {
      const kinds: string[] = [];
      const outcome = await settle(
        fault.watch(
          faultSnapshot(id),
          message => kinds.push(message.kind),
          new AbortController().signal,
        ),
        5000,
      );
      return { ...outcome, kinds };
    });

  await scenario('large', async () => {
    await report({ scenario: 'large', driver, phase: 'start' });
    let characters = 0;
    let records = 0;
    let terminal = false;
    const outcome = await settle(
      fault.watch(
        faultSnapshot(faults.large),
        message => {
          const text = providerText(message);
          if (text !== null) {
            characters += text.length;
            records += 1;
          }
          if (terminalText(message) === 'large done') terminal = true;
        },
        new AbortController().signal,
      ),
      240000,
    );
    return {
      ...outcome,
      records,
      characters,
      expectedCharacters: faults.largeRecords * faults.largeRecordCharacters,
      terminal,
    };
  });

  for (const when of ['before-accepted', 'after-accepted'] as const)
    await scenario(`acceptance-loss-${when}`, async () => {
      await post('/harness/control', { op: 'drop', when });
      const input = submission();
      const kinds: string[] = [];
      const lost = await settle(
        server.submit(
          input,
          message => kinds.push(message.kind),
          new AbortController().signal,
        ),
        8000,
      );
      const recovered = await server.get(
        input.attemptId,
        new AbortController().signal,
      );
      await post('/harness/control', {
        op: 'complete',
        attemptId: input.attemptId,
        text: 'RESPONSE-BODY-MARKER recovered',
      });
      const texts: string[] = [];
      const watched = await settle(
        server.watch(
          recovered,
          message => {
            const text = terminalText(message);
            if (text) texts.push(text);
          },
          new AbortController().signal,
        ),
        8000,
      );
      const final = await job(input.attemptId);
      return {
        attemptId: input.attemptId,
        lost,
        kindsBeforeLoss: kinds,
        recoveredSameAttempt: recovered.attemptId === input.attemptId,
        recoveredStatus: recovered.status,
        watched,
        recoveredText: texts.at(-1) ?? null,
        dispatches: final.dispatches,
      };
    });

  await scenario('lifecycle', async () => {
    const controller = new AbortController();
    const timeline: Array<{ t: number; event: string }> = [];
    const started = Date.now();
    const note = (event: string) =>
      timeline.push({ t: Date.now() - started, event });
    const states: string[] = [];
    const subscription = AppState.addEventListener('change', state => {
      states.push(state);
      note(`app-${state}`);
    });
    let received = 0;
    const pending = fault.watch(
      faultSnapshot(faults.drip),
      () => {
        received += 1;
        if (received % 10 === 0) note(`received-${received}`);
      },
      controller.signal,
    );
    const stream = settle(pending, 120000);
    await report({ scenario: 'lifecycle', driver, phase: 'ready' });
    for (
      let i = 0;
      i < 90 && !(states.includes('background') && states.at(-1) === 'active');
      i += 1
    )
      await wait(1000);
    await wait(3000);
    note(`abort-after-${received}`);
    controller.abort();
    const outcome = await stream;
    subscription.remove();
    return { ...outcome, states, timeline, received };
  });

  for (const [name, transport] of [
    ['socket-submit', server],
    ['socket-redirect', fault],
  ] as const)
    await scenario(name, async () => {
      const kinds: string[] = [];
      const texts: string[] = [];
      const outcome = await settle(
        transport.submit(
          { ...submission(), picker: 'auto' },
          message => {
            kinds.push(message.kind);
            const text = terminalText(message);
            if (text) texts.push(text);
          },
          new AbortController().signal,
        ),
        20000,
      );
      transport.disconnect();
      return { ...outcome, kinds, text: texts.at(-1) ?? null };
    });

  await scenario('uncredentialed-devtools-control', async () => {
    const response = await nativeDrivers.fetch(
      `${api}/harness/uncredentialed`,
      {
        method: 'GET',
        redirect: 'error',
        signal: timeout(),
        headers: {},
      },
    );
    return { status: response.status, text: await response.text() };
  });

  const entries = JSON.stringify(NetworkInspector.getEntries());
  await report({
    scenario: 'inspector',
    driver,
    entries: NetworkInspector.getEntries().length,
    containsCredential: entries.includes(device),
    containsRequestBody: entries.includes('REQUEST-BODY-MARKER'),
    containsResponseBody: entries.includes('RESPONSE-BODY-MARKER'),
  });
  await report({ final: true, driver });
  show('done');
}

function Harness() {
  const [status, setStatus] = useState('starting');
  useEffect(() => {
    const seed: unknown = Settings.get('NativeHarnessSeed');
    const device =
      typeof seed === 'string' ? [...seed].reverse().join('') : null;
    const driver: unknown = Settings.get('NativeHarnessDriver');
    if (device === null || typeof driver !== 'string') {
      setStatus('missing launch arguments');
      return;
    }
    void run(driver, device, setStatus);
  }, []);
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text>{status}</Text>
    </View>
  );
}

AppRegistry.registerComponent('MargeloChat', () => Harness);
