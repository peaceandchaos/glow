import { models, type ModelConfig } from '../src/models';

test('each Responses model compacts before its context window fills', () => {
  const responses = Object.values(models).flatMap(config =>
    config.wire === 'responses' ? [config] : [],
  );
  expect(responses.length).toBeGreaterThan(0);
  for (const config of responses)
    expect(config.compactThreshold).toBeLessThan(
      config.window - config.maxOutput,
    );
});

// npm run typecheck enforces this test through @ts-expect-error; Jest only runs it.
test('a Responses model without compactThreshold is not a model config', () => {
  // @ts-expect-error A Responses model must set compactThreshold.
  const missing: ModelConfig = {
    id: 'fixture',
    wire: 'responses',
    window: 1,
    maxOutput: 1,
    threshold: 1,
  };
});
