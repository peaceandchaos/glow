import {
  defaultMenu,
  effortFor,
  menuFrom,
  models,
  type ModelConfig,
} from '../src/models';

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
    label: 'Fixture',
    levels: [],
    wire: 'responses',
    window: 1,
    maxOutput: 1,
    threshold: 1,
  };
});

test('each model lists the reasoning efforts its provider accepts', () => {
  expect(
    Object.fromEntries(
      Object.entries(models).map(([key, config]) => [key, config.levels]),
    ),
  ).toEqual({
    kimi: ['none', 'low', 'high', 'max'],
    deepseek: ['none', 'low', 'high', 'max'],
    'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
  });
});

test('an effort the model does not accept is omitted', () => {
  expect(effortFor('kimi', 'high')).toBe('high');
  expect(effortFor('gpt-6-astra', 'none')).toBeNull();
  expect(effortFor('gpt-6.1-sol', 'turbo')).toBeNull();
  expect(effortFor('deepseek', null)).toBeNull();
});

describe('MODEL_MENU', () => {
  let logged: jest.SpyInstance;
  beforeEach(() => {
    logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => logged.mockRestore());

  test('unset or the default value gives the default menu', () => {
    expect(menuFrom(undefined)).toBe(defaultMenu);
    expect(menuFrom(JSON.stringify(defaultMenu))).toEqual(defaultMenu);
    expect(logged).not.toHaveBeenCalled();
  });

  test('a valid value replaces the whole menu in its order', () => {
    const menu = {
      auto: false,
      models: [
        { model: 'gpt-6-astra', levels: ['low', 'high'], defaultLevel: null },
        { model: 'kimi', levels: [], defaultLevel: null },
      ],
    };
    expect(menuFrom(JSON.stringify(menu))).toEqual(menu);
    expect(logged).not.toHaveBeenCalled();
  });

  test.each([
    ['bad JSON', '{"auto":true,'],
    ['no models', '{"auto":true,"models":[]}'],
    [
      'an unknown model',
      '{"auto":true,"models":[{"model":"gpt-9","levels":[],"defaultLevel":null}]}',
    ],
    [
      'none on Astra',
      '{"auto":true,"models":[{"model":"gpt-6-astra","levels":["none"],"defaultLevel":null}]}',
    ],
    [
      'a default level it does not offer',
      '{"auto":true,"models":[{"model":"gpt-6.1-sol","levels":["low"],"defaultLevel":"medium"}]}',
    ],
    [
      'a duplicate model',
      '{"auto":true,"models":[{"model":"kimi","levels":[],"defaultLevel":null},{"model":"kimi","levels":["low"],"defaultLevel":null}]}',
    ],
  ])('%s logs once and serves the default menu', (_name, raw) => {
    expect(menuFrom(raw)).toBe(defaultMenu);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toMatch(/^MODEL_MENU ignored: /u);
  });
});
