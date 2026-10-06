import { randomUUID } from 'node:crypto';
import { textItem } from '../src/compaction/context';
import { runtimeJev, runtimeProviders } from '../src/runtime';
import { submission } from './fixtures';

// @vercel/oidc reads exp without checking the signature, and refreshes a
// missing or expired token over the network.
const encode = (json: string) => Buffer.from(json).toString('base64url');
const oidcToken = [
  encode('{"alg":"RS256","typ":"JWT"}'),
  encode(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  'signature',
].join('.');

const environment = process.env;
let requests: Headers[] = [];

beforeEach(() => {
  process.env = {
    ...environment,
    OPENAI_API_KEY: 'example-key',
    VERCEL_OIDC_TOKEN: oidcToken,
  };
  delete process.env.AI_GATEWAY_API_KEY;
  requests = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    requests.push(new Headers(init?.headers));
    return Promise.resolve(
      Response.json({ error: 'Fixture failure' }, { status: 500 }),
    );
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env = environment;
});

function sendToGateway() {
  return runtimeProviders().generate(
    submission(),
    'deepseek',
    { items: [textItem('user', 'Hello')], checkpoint: null },
    new AbortController().signal,
    () => Promise.resolve(),
    () => Promise.resolve(),
    null,
  );
}

function rankWithJev() {
  return runtimeJev().rank(
    {
      query: 'hello',
      candidates: [
        { id: randomUUID(), title: 'First' },
        { id: randomUUID(), title: 'Second' },
      ],
    },
    new AbortController().signal,
  );
}

test('without a Gateway key, the chat client sends the Vercel OIDC token', async () => {
  await expect(sendToGateway()).rejects.toThrow('HTTP 500');
  expect(requests.map(headers => headers.get('Authorization'))).toEqual([
    `Bearer ${oidcToken}`,
  ]);
});

test('without a Gateway key, Jev authenticates through @ai-sdk/gateway in OIDC mode', async () => {
  await expect(rankWithJev()).rejects.toThrow();
  expect(
    requests.map(headers => [
      headers.get('Authorization'),
      headers.get('ai-gateway-auth-method'),
    ]),
  ).toEqual([[`Bearer ${oidcToken}`, 'oidc']]);
});

test('an empty Gateway key counts as no key for both clients', async () => {
  process.env.AI_GATEWAY_API_KEY = '';
  await expect(sendToGateway()).rejects.toThrow('HTTP 500');
  await expect(rankWithJev()).rejects.toThrow();
  expect(
    requests.map(headers => [
      headers.get('Authorization'),
      headers.get('ai-gateway-auth-method'),
    ]),
  ).toEqual([
    [`Bearer ${oidcToken}`, null],
    [`Bearer ${oidcToken}`, 'oidc'],
  ]);
});

test('a Gateway key, when set, is used instead of the OIDC token', async () => {
  process.env.AI_GATEWAY_API_KEY = 'example-gateway-key';
  await expect(sendToGateway()).rejects.toThrow('HTTP 500');
  await expect(rankWithJev()).rejects.toThrow();
  expect(
    requests.map(headers => [
      headers.get('Authorization'),
      headers.get('ai-gateway-auth-method'),
    ]),
  ).toEqual([
    ['Bearer example-gateway-key', null],
    ['Bearer example-gateway-key', 'api-key'],
  ]);
});
