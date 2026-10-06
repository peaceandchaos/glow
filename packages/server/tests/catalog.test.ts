import {
  bakedCatalog,
  parseCatalog,
  resolveChoice,
  type Catalog,
} from '../../../shared/catalog';
import { catalogFrom, defaultMenu, menuFrom } from '../src/models';

const [deepseek, , sol] = bakedCatalog.models;
const catalog: Catalog = { auto: true, models: [deepseek, sol] };
const lunaMenu =
  '{"auto":true,"models":[{"model":"deepseek","levels":["none","low","high","max"]},{"model":"kimi","levels":["none","low","high","max"]},{"model":"gpt-6.1-sol","levels":["low","medium","high","xhigh","max"]},{"model":"gpt-6-astra","levels":["low","medium","high","xhigh","max"]},{"model":"gpt-6-luna","levels":["none","low","medium","high","xhigh","max"]}]}';

test.each([
  ['Auto with Auto on', true, 'auto', 'max', { kind: 'auto' }],
  [
    'Auto with Auto off',
    false,
    'auto',
    'max',
    { kind: 'model', model: deepseek, level: 'none' },
  ],
  [
    'a listed model and level',
    true,
    'gpt-6.1-sol',
    'high',
    { kind: 'model', model: sol, level: 'high' },
  ],
  [
    'a listed model with no level',
    true,
    'gpt-6.1-sol',
    undefined,
    { kind: 'model', model: sol, level: 'low' },
  ],
  [
    'a listed model with an unlisted level',
    true,
    'gpt-6.1-sol',
    'none',
    { kind: 'model', model: sol, level: 'low' },
  ],
  [
    'an unlisted model',
    true,
    'gpt-6-astra',
    'high',
    { kind: 'model', model: deepseek, level: 'none' },
  ],
])(
  '%s resolves to the catalog choice',
  (_name, auto, picker, level, choice) => {
    expect(resolveChoice({ ...catalog, auto }, picker, level)).toEqual(choice);
  },
);

test('the server default menu is the catalog the app bakes in', () => {
  expect(catalogFrom(defaultMenu)).toEqual(bakedCatalog);
});

test('the documented MODEL_MENU value for the default menu reproduces it', () => {
  const value =
    '{"auto":true,"models":[{"model":"deepseek","levels":["none","low","high","max"]},{"model":"kimi","levels":["none","low","high","max"]},{"model":"gpt-6.1-sol","levels":["low","medium","high","xhigh","max"]},{"model":"gpt-6-astra","levels":["low","medium","high","xhigh","max"]}]}';
  expect(catalogFrom(menuFrom(value))).toEqual(bakedCatalog);
});

test('the documented MODEL_MENU value with Luna appends it to the menu', () => {
  const value = lunaMenu;
  expect(catalogFrom(menuFrom(value))).toEqual({
    auto: true,
    models: [
      ...bakedCatalog.models,
      {
        key: 'gpt-6-luna',
        label: 'GPT-6 Luna',
        transport: 'socket',
        levels: [
          { key: 'none', label: 'None' },
          { key: 'low', label: 'Low' },
          { key: 'medium', label: 'Medium' },
          { key: 'high', label: 'High' },
          { key: 'xhigh', label: 'Extra high' },
          { key: 'max', label: 'Max' },
        ],
      },
    ],
  });
});

test('a catalog body reads back unchanged', () => {
  expect(parseCatalog(JSON.stringify(bakedCatalog))).toEqual(bakedCatalog);
});

test('an unreadable model or level is skipped, not fatal', () => {
  const body = {
    auto: false,
    future: 'ignored',
    models: [
      {
        key: 'Bad Key',
        label: 'Bad',
        transport: 'http',
        levels: [],
        defaultLevel: null,
      },
      {
        key: 'gpt-6-luna',
        label: 'GPT-6 Luna',
        transport: 'pigeon',
        levels: [],
        defaultLevel: null,
      },
      {
        key: 'gpt-7',
        label: 'GPT-7',
        transport: 'socket',
        badge: 'new',
        levels: [
          { key: 'low', label: 'Low' },
          { key: 'LOUD', label: 'Loud' },
          { key: 'max', label: '' },
          { key: 'high', label: 'High', hint: 'ignored' },
        ],
        defaultLevel: 'max',
      },
      {
        key: 'gpt-7',
        label: 'Duplicate',
        transport: 'http',
        levels: [],
        defaultLevel: null,
      },
      {
        key: 'kimi',
        label: 'Kimi K3',
        transport: 'http',
        levels: 'none',
        defaultLevel: null,
      },
    ],
  };
  expect(parseCatalog(JSON.stringify(body))).toEqual({
    auto: false,
    models: [
      {
        key: 'gpt-7',
        label: 'GPT-7',
        transport: 'socket',
        levels: [
          { key: 'low', label: 'Low' },
          { key: 'high', label: 'High' },
        ],
      },
    ],
  });
});

test('every model starts at the first of its levels', () => {
  const menu = catalogFrom(menuFrom(lunaMenu));
  const defaults = menu.models.map(model => {
    const choice = resolveChoice(menu, model.key, undefined);
    return [model.key, choice.kind === 'model' ? choice.level : choice.kind];
  });
  expect(defaults).toEqual([
    ['deepseek', 'none'],
    ['kimi', 'none'],
    ['gpt-6.1-sol', 'low'],
    ['gpt-6-astra', 'low'],
    ['gpt-6-luna', 'none'],
  ]);
});

test('a model with no levels sends no level', () => {
  const bare: Catalog = { auto: false, models: [{ ...sol, levels: [] }] };
  expect(resolveChoice(bare, 'gpt-6.1-sol', 'high')).toEqual({
    kind: 'model',
    model: bare.models[0],
    level: null,
  });
});

test.each([
  ['bad JSON', '{"auto":'],
  ['a bad envelope', '{"auto":"yes","models":[]}'],
  ['no models', '{"auto":true,"models":[]}'],
  [
    'no readable model',
    '{"auto":true,"models":[{"key":"auto","label":"Auto","levels":[],"defaultLevel":null}]}',
  ],
])('%s gives no catalog', (_name, text) => {
  expect(parseCatalog(text)).toBeNull();
});
