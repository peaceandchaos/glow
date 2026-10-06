// Runs the native transport harness on an iOS simulator and judges the evidence.
// Usage: node tools/native-transport/run.mjs --app <MargeloChat.app> --udid <sim>
//          --driver binding|draft --out <dir> [--background-seconds 20] [--keep-booted] [--cdp] [--instrumented]
// Build the app first with a plain Debug simulator xcodebuild. Needs port 8081 free.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    app: { type: 'string' },
    udid: { type: 'string' },
    driver: { type: 'string', default: 'binding' },
    out: { type: 'string' },
    'background-seconds': { type: 'string', default: '20' },
    'keep-booted': { type: 'boolean', default: false },
    // Attaching this raw CDP client crashed Hermes' debugger on 30 Sep 2026.
    cdp: { type: 'boolean', default: false },
    // The app was built with SWIFT_ACTIVE_COMPILATION_CONDITIONS including
    // NITROFETCH_HARNESS, so the nitro-fetch patch logs its counters.
    instrumented: { type: 'boolean', default: false },
  },
});
if (!args.app || !args.udid || !args.out)
  throw new Error('Pass --app, --udid, and --out.');

const root = resolve(import.meta.dirname, '../..');
const out = resolve(args.out);
mkdirSync(out, { recursive: true });
const faults = JSON.parse(
  readFileSync(join(import.meta.dirname, 'faults.json'), 'utf8'),
);
const bundleId = execFileSync(
  'plutil',
  [
    '-extract',
    'CFBundleIdentifier',
    'raw',
    join(resolve(args.app), 'Info.plist'),
  ],
  { encoding: 'utf8' },
).trim();
// iOS logs launch arguments at debug level, so the app receives a seed and
// derives the credential; the logs then show the seed, never the credential.
const seed = randomBytes(32).toString('base64url');
const credential = [...seed].reverse().join('');
const children = [];
const started = Date.now();
const note = event =>
  writeFileSync(
    join(out, 'runner.jsonl'),
    `${JSON.stringify({ t: Date.now() - started, ...event })}\n`,
    { flag: 'a' },
  );
const simctl = (...rest) =>
  execFileSync('xcrun', ['simctl', ...rest], { encoding: 'utf8' });
const lines = file =>
  existsSync(join(out, file))
    ? readFileSync(join(out, file), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    : [];

function start(name, command, commandArgs, options = {}) {
  const log = createWriteStream(join(out, `${name}.log`));
  const child = spawn(command, commandArgs, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.push(child);
  return child;
}

async function until(check, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

const reachable = url =>
  fetch(url).then(
    response => response,
    () => null,
  );
const control = body =>
  fetch(`http://localhost:${faults.ports.api}/harness/control`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

try {
  start(
    'server',
    process.execPath,
    [
      '--experimental-transform-types',
      '--no-warnings',
      '--import',
      join(import.meta.dirname, 'hooks.mjs'),
      join(import.meta.dirname, 'server.mjs'),
    ],
    {
      env: {
        ...process.env,
        NATIVE_HARNESS_DEVICE: credential,
        NATIVE_HARNESS_OUT: out,
      },
    },
  );
  await until(
    () => lines('access.log').some(entry => entry.event === 'listening'),
    'server',
  );

  start(
    'metro',
    'npx',
    [
      'react-native',
      'start',
      '--port',
      '8081',
      '--config',
      join(import.meta.dirname, 'metro.config.cjs'),
    ],
    {
      cwd: join(root, 'packages/app'),
    },
  );
  await until(
    async () =>
      (
        await (await reachable('http://localhost:8081/status'))?.text()
      )?.includes('running'),
    'Metro',
  );

  try {
    simctl('boot', args.udid);
  } catch {
    note({ event: 'already-booted' });
  }
  simctl('bootstatus', args.udid, '-b');
  simctl('install', args.udid, args.app);
  start('device', 'xcrun', [
    'simctl',
    'spawn',
    args.udid,
    'log',
    'stream',
    '--level',
    'debug',
    '--style',
    'compact',
    '--predicate',
    'process == "MargeloChat"',
  ]);
  simctl(
    'launch',
    '--terminate-running-process',
    args.udid,
    bundleId,
    '-NativeHarnessSeed',
    seed,
    '-NativeHarnessDriver',
    args.driver,
  );
  note({ event: 'launched', driver: args.driver });

  const pid = await until(() => {
    try {
      return execFileSync('pgrep', ['-f', '/MargeloChat -NativeHarness'], {
        encoding: 'utf8',
      })
        .trim()
        .split('\n')[0];
    } catch {
      return null;
    }
  }, 'app process');
  const rss = setInterval(() => {
    try {
      const kb = Number(
        execFileSync('ps', ['-o', 'rss=', '-p', pid], {
          encoding: 'utf8',
        }).trim(),
      );
      writeFileSync(
        join(out, 'rss.jsonl'),
        `${JSON.stringify({ t: Date.now() - started, kb })}\n`,
        { flag: 'a' },
      );
    } catch {
      /* The process can exit between samples. */
    }
  }, 250);

  const target = !args.cdp
    ? null
    : await until(
        async () => {
          const list = await (
            await reachable('http://localhost:8081/json/list')
          )
            ?.json()
            .catch(() => null);
          return list?.find(page => page.webSocketDebuggerUrl);
        },
        'debugger target',
        60_000,
      ).catch(() => null);
  const cdp = createWriteStream(join(out, 'cdp.jsonl'));
  if (target) {
    // Metro's inspector proxy accepts only local DevTools origins.
    const socket = new WebSocket(target.webSocketDebuggerUrl, {
      headers: { Origin: 'http://localhost:8081' },
    });
    socket.onmessage = event => cdp.write(`${event.data}\n`);
    await new Promise((ready, failed) => {
      socket.onopen = ready;
      socket.onerror = failed;
    });
    socket.send(
      JSON.stringify({ id: 1, method: 'Network.enable', params: {} }),
    );
    await until(
      () => readFileSync(join(out, 'cdp.jsonl'), 'utf8').includes('"id":1'),
      'Network.enable',
      10_000,
    );
    note({ event: 'cdp-network-enabled', title: target.title });
  } else note({ event: 'cdp-unavailable' });
  await control({ op: 'go' });
  note({ event: 'go' });

  await until(
    () =>
      lines('reports.jsonl').some(
        entry => entry.scenario === 'lifecycle' && entry.phase === 'ready',
      ),
    'lifecycle',
    600_000,
  );
  await delay(3000);
  simctl('launch', args.udid, 'com.apple.Preferences');
  note({ event: 'backgrounded' });
  await delay(Number(args['background-seconds']) * 1000);
  simctl('launch', args.udid, bundleId);
  note({ event: 'foregrounded' });

  await until(
    () => lines('reports.jsonl').some(entry => entry.final),
    'final report',
    300_000,
  );
  await delay(2000);
  clearInterval(rss);
  const connections = await (
    await fetch(`http://localhost:${faults.ports.api}/harness/connections`)
  ).json();
  writeFileSync(join(out, 'connections.json'), JSON.stringify(connections));
  try {
    writeFileSync(
      join(out, 'lsof.txt'),
      execFileSync('lsof', ['-a', '-p', pid, '-iTCP'], { encoding: 'utf8' }),
    );
  } catch (error) {
    writeFileSync(join(out, 'lsof.txt'), `lsof failed: ${error.message}`);
  }
  simctl('terminate', args.udid, bundleId);
} finally {
  for (const child of children) child.kill('SIGTERM');
  if (!args['keep-booted']) {
    try {
      simctl('shutdown', args.udid);
    } catch {
      /* Already shut down. */
    }
  }
}

const reports = Object.fromEntries(
  lines('reports.jsonl')
    .filter(entry => entry.scenario && !entry.phase)
    .map(entry => [entry.scenario, entry]),
);
const access = lines('access.log');
const requests = access.filter(entry => entry.event === 'request');
const closed = path =>
  access.find(entry => entry.path === path && entry.event !== 'request');
const opened = path =>
  access.find(entry => entry.path === path && entry.event === 'request');
const closeDelay = path =>
  closed(path) ? closed(path).t - opened(path).t : null;
const read = file =>
  existsSync(join(out, file)) ? readFileSync(join(out, file), 'utf8') : '';
const aborted = entry =>
  entry?.state === 'rejected' && entry.error.name === 'AbortError';
const counters = args.instrumented
  ? {
      liveAdapters:
        [
          ...read('device.log').matchAll(
            /NitroFetchHarness adapters live=(\d+)/gu,
          ),
        ]
          .map(match => Number(match[1]))
          .at(-1) ?? null,
      devToolsReports: (
        read('device.log').match(
          /NitroFetchHarness devtools reported a request/gu,
        ) ?? []
      ).length,
    }
  : null;
const connections = existsSync(join(out, 'connections.json'))
  ? JSON.parse(read('connections.json'))
  : null;
const rssSamples = lines('rss.jsonl');
const largeStart = lines('reports.jsonl').find(
  entry => entry.scenario === 'large' && entry.phase === 'start',
);
const largeEnd = requests.length
  ? access.find(
      entry => entry.path?.includes(faults.large) && entry.event !== 'request',
    )
  : null;
const during = rssSamples.filter(
  sample =>
    largeStart &&
    sample.t >= largeStart.t &&
    (!largeEnd || sample.t <= largeEnd.t + 5000),
);
const hold = `/v1/jobs/${faults.hold}`;
const drip = `/v1/jobs/${faults.drip}/events`;
const detach = reports['detach-real-job-then-stop'];
const stops = requests.filter(entry => entry.path.endsWith('/stop'));
const secrets = file => ({
  credential: read(file).includes(credential),
  requestBody: read(file).includes('REQUEST-BODY-MARKER'),
  responseBody: read(file).includes('RESPONSE-BODY-MARKER'),
});

const checks = {
  'abort before headers (get) reaches native':
    aborted(reports['abort-before-headers-get']) &&
    reports['abort-before-headers-get'].ms < 1000 &&
    closeDelay(hold) !== null &&
    closeDelay(hold) < 2000,
  'abort before headers (stream) reaches native':
    aborted(reports['abort-before-headers-watch']) &&
    reports['abort-before-headers-watch'].ms < 1000 &&
    closeDelay(`${hold}/events`) !== null &&
    closeDelay(`${hold}/events`) < 2000,
  'abort during stream settles once and closes the request':
    reports['abort-during-stream']?.state !== 'hung' &&
    reports['abort-during-stream']?.ms < 2000 &&
    reports['abort-during-stream']?.lateReceives === 0 &&
    closeDelay(drip) !== null &&
    closeDelay(drip) < 3000,
  'reader detach never calls Stop; explicit Stop does':
    detach?.detach?.state !== 'hung' &&
    detach?.afterDetach?.cancelRequested === false &&
    detach?.afterDetach?.dispatches === 1 &&
    stops.length === 1 &&
    stops[0].path.includes(detach.attemptId) &&
    detach?.afterStop?.cancelRequested === true,
  'redirected get fails': reports['redirect-get']?.state === 'rejected',
  'redirected stream fails': reports['redirect-watch']?.state === 'rejected',
  'redirect target receives no request': !requests.some(
    entry => entry.server === 'target',
  ),
  'admission errors keep status and message':
    Object.entries(faults.admission).every(([status]) => {
      const result = reports['admission-errors']?.results?.[status];
      return (
        result?.state === 'rejected' &&
        result.error.status === Number(status) &&
        result.error.message === `Fixture admission ${status}.`
      );
    }) && reports['admission-errors']?.results?.real401?.error?.status === 401,
  'split UTF-8 reconstructs exactly':
    reports['utf8-split']?.exact === true &&
    reports['utf8-split']?.splitBoundaries > 0,
  'truncated stream fails': reports.truncated?.state === 'rejected',
  'malformed SSE fails': reports['malformed-sse']?.state === 'rejected',
  'large stream completes':
    reports.large?.state === 'resolved' &&
    reports.large?.characters === reports.large?.expectedCharacters &&
    reports.large?.terminal === true,
  // 'aé' is three UTF-8 bytes per two characters.
  'large stream buffers under half its payload':
    during.length > 0 &&
    (Math.max(...during.map(sample => sample.kb)) - during[0].kb) * 1024 <
      (faults.largeRecords * faults.largeRecordCharacters * 1.5) / 2,
  'lost acceptance recovers the same attempt without resubmission': [
    'before-accepted',
    'after-accepted',
  ].every(when => {
    const entry = reports[`acceptance-loss-${when}`];
    return (
      entry?.recoveredSameAttempt &&
      entry.dispatches === 1 &&
      entry.watched?.state === 'resolved' &&
      entry.recoveredText === 'RESPONSE-BODY-MARKER recovered'
    );
  }),
  'connection loss before acceptance is reported':
    reports['acceptance-loss-before-accepted']?.lost?.state === 'rejected',
  'connection loss after acceptance is reported':
    reports['acceptance-loss-after-accepted']?.lost?.state === 'rejected',
  'finished native requests hold no connections':
    connections?.fault === 0 && connections?.target === 0,
  'socket submission completes on the intended host':
    reports['socket-submit']?.state === 'resolved' &&
    reports['socket-submit']?.text === 'RESPONSE-BODY-MARKER socket' &&
    access.some(
      entry =>
        entry.server === 'api' &&
        entry.event === 'upgrade' &&
        entry.credential === 'fixture',
    ),
  'redirected socket handshake fails':
    reports['socket-redirect']?.state === 'rejected',
  'socket redirect target receives no handshake': !access.some(
    entry => entry.server === 'target' && entry.event === 'upgrade',
  ),
  ...(counters
    ? {
        'native request objects are released': counters.liveAdapters === 0,
        'DevTools reporter receives no request':
          counters.liveAdapters !== null &&
          counters.devToolsReports === 0 &&
          reports['uncredentialed-devtools-control']?.text === 'control' &&
          requests.some(
            entry =>
              entry.path === '/harness/uncredentialed' &&
              entry.credential === 'absent',
          ),
      }
    : {}),
  'JS network inspector holds no credential or bodies':
    reports.inspector?.containsCredential === false &&
    reports.inspector?.containsRequestBody === false &&
    reports.inspector?.containsResponseBody === false,
  ...(args.cdp
    ? {
        'DevTools network events hold no credential or bodies':
          read('runner.jsonl').includes('cdp-network-enabled') &&
          !Object.values(secrets('cdp.jsonl')).some(Boolean),
      }
    : {}),
  'device log holds no credential or bodies': !Object.values(
    secrets('device.log'),
  ).some(Boolean),
};
const summary = {
  driver: args.driver,
  checks,
  evidence: {
    closeDelayMs: {
      hold: closeDelay(hold),
      holdEvents: closeDelay(`${hold}/events`),
      drip: closeDelay(drip),
    },
    stops: stops.map(entry => entry.path),
    targetRequests: requests
      .filter(entry => entry.server === 'target')
      .map(entry => ({ path: entry.path, credential: entry.credential })),
    largeRssKb: during.length
      ? {
          start: during[0].kb,
          peak: Math.max(...during.map(sample => sample.kb)),
        }
      : null,
    openConnectionsAtEnd: connections,
    ...(counters ? { counters } : {}),
    openHarnessSockets: read('lsof.txt')
      .split('\n')
      .filter(line => /:879[123]/u.test(line)).length,
    secrets: { cdp: secrets('cdp.jsonl'), device: secrets('device.log') },
    reports,
  },
};
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
for (const [name, ok] of Object.entries(checks))
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(
  JSON.stringify({ ...summary.evidence, reports: undefined }, null, 2),
);
process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
