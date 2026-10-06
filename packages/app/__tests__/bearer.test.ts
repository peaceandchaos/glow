import { ServerTransport, type ClientDrivers } from '../src/network/client';

test('server requests carry the session token as a bearer credential and nothing else', async () => {
  const calls: Parameters<ClientDrivers['fetch']>[] = [];
  const drivers: ClientDrivers = {
    fetch: (...call) => {
      calls.push(call);
      return Promise.resolve({
        ok: true,
        status: 204,
        body: null,
        text: () => Promise.resolve(''),
      });
    },
    socket: () => {
      throw new Error('No socket in this test.');
    },
    decoder: () => {
      throw new Error('No decoder in this test.');
    },
  };
  const transport = new ServerTransport(
    'https://glow.example',
    'session-token',
    drivers,
  );

  await transport.deleteChat(
    '00000000-0000-4000-8000-000000000001',
    new AbortController().signal,
  );

  expect(calls).toHaveLength(1);
  expect(calls[0][1].headers).toEqual({
    Authorization: 'Bearer session-token',
    'Content-Type': 'application/json',
  });
});
