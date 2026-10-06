import {
  bakedCatalog,
  parseCatalog,
  resolveChoice,
  type Catalog,
} from '../../../shared/catalog';
import { catalogFrom, defaultMenu, menuFrom } from '../src/models';

const [deepseek, , sol] = bakedCatalog.models;
const catalog: Catalog = { auto: true, models: [deepseek, sol] };

test.each([
  ['Auto with Auto on', true, 'auto', 'max', { kind: 'auto' }],
  [
    'Auto with Auto off',
    false,
    'auto',
    'max',
    { kind: 'model', model: deepseek, level: null },
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
    { kind: 'model', model: sol, level: 'medium' },
  ],
  [
    'a listed model with an unlisted level',
    true,
    'gpt-6.1-sol',
    'none',
    { kind: 'model', model: sol, level: 'medium' },
  ],
  [
    'an unlisted model',
    true,
    'gpt-6-astra',
    'high',
    { kind: 'model', model: deepseek, level: null },
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
    '{"auto":true,"models":[{"model":"deepseek","levels":["none","low","high","max"],"defaultLevel":null},{"model":"kimi","levels":["none","low","high","max"],"defaultLevel":null},{"model":"gpt-6.1-sol","levels":["low","medium","high","xhigh","max"],"defaultLevel":"medium"},{"model":"gpt-6-astra","levels":["low","medium","high","xhigh","max"],"defaultLevel":"medium"}]}';
  expect(catalogFrom(menuFrom(value))).toEqual(bakedCatalog);
});

test('the documented MODEL_MENU value with Luna appends it to the menu', () => {
  const value =
    '{"auto":true,"models":[{"model":"deepseek","levels":["none","low","high","max"],"defaultLevel":null},{"model":"kimi","levels":["none","low","high","max"],"defaultLevel":null},{"model":"gpt-6.1-sol","levels":["low","medium","high","xhigh","max"],"defaultLevel":"medium"},{"model":"gpt-6-astra","levels":["low","medium","high","xhigh","max"],"defaultLevel":"medium"},{"model":"gpt-6-luna","levels":["none","low","medium","high","xhigh","max"],"defaultLevel":"medium"}]}';
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
        defaultLevel: 'medium',
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
        defaultLevel: null,
      },
    ],
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
