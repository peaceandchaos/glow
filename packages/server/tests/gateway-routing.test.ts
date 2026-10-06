import type { ModelKey } from '../../../shared/contracts';
import { textItem } from '../src/compaction/context';
import { GatewayClient } from '../src/gateway';
import { gatewayHosts, models } from '../src/models';
import { exampleGatewayAuth } from './fixtures';

const signal = new AbortController().signal;
const before = () => Promise.resolve();

async function sentBody(model: ModelKey): Promise<string> {
  const bodies: string[] = [];
  const client = new GatewayClient({
    auth: exampleGatewayAuth,
    fetcher: (_url, init) => {
      if (typeof init?.body === 'string') bodies.push(init.body);
      return Promise.resolve(new Response(null, { status: 500 }));
    },
  });
  await expect(
    client.generate(
      model,
      [textItem('user', 'Hello')],
      signal,
      before,
      before,
      null,
    ),
  ).rejects.toThrow('HTTP 500');
  expect(bodies).toHaveLength(1);
  return bodies[0];
}

test.each<[ModelKey, string[]]>([
  ['kimi', ['bedrock', 'fireworks']],
  ['deepseek', ['fireworks', 'baseten']],
])(
  '%s goes only to its US zero-retention hosts, in order',
  async (model, hosts) => {
    expect(JSON.parse(await sentBody(model)).providerOptions).toEqual({
      gateway: {
        order: hosts,
        only: hosts,
        disallowPromptTraining: true,
        inferenceRegion: { scope: 'zone', geoRegion: 'us' },
      },
    });
  },
);

test('only Gateway models have hosts, and a GPT model never reaches the Gateway', async () => {
  expect(Object.keys(gatewayHosts)).toEqual(
    Object.entries(models).flatMap(([key, config]) =>
      config.wire === 'gateway' ? [key] : [],
    ),
  );
  const fetcher = jest.fn(() => Promise.resolve(new Response(null)));
  const client = new GatewayClient({ auth: exampleGatewayAuth, fetcher });
  await expect(
    client.generate(
      'gpt-6.1-sol',
      [textItem('user', 'Hello')],
      signal,
      before,
      before,
      null,
    ),
  ).rejects.toThrow('does not run through AI Gateway');
  expect(fetcher).not.toHaveBeenCalled();
});
