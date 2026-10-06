import {
  bakedCatalog,
  parseCatalog,
  resolveChoice,
  type Catalog,
} from '../../../shared/catalog';
import { catalogFrom, defaultMenu, menuFrom } from '../src/models';

const sol = bakedCatalog.models[2];
const catalog: Catalog = { auto: true, models: [bakedCatalog.models[0], sol] };

test.each([
  ['Auto with Auto on', true, 'auto', 'max', { kind: 'auto' }],
  [
    'Auto with Auto off',
    false,
    'auto',
    'max',
    { kind: 'model', model: 'deepseek', level: null },
  ],
  [
    'a listed model and level',
    true,
    'gpt-6.1-sol',
    'high',
    { kind: 'model', model: 'gpt-6.1-sol', level: 'high' },
  ],
  [
    'a listed model with no level',
    true,
    'gpt-6.1-sol',
    undefined,
    { kind: 'model', model: 'gpt-6.1-sol', level: 'medium' },
  ],
  [
    'a listed model with an unlisted level',
    true,
    'gpt-6.1-sol',
    'none',
    { kind: 'model', model: 'gpt-6.1-sol', level: 'medium' },
  ],
  [
    'an unlisted model',
    true,
    'gpt-6-astra',
    'high',
    { kind: 'model', model: 'deepseek', level: null },
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

test('a catalog body reads back unchanged', () => {
  expect(parseCatalog(JSON.stringify(bakedCatalog))).toEqual(bakedCatalog);
});

test('an unreadable model or level is skipped, not fatal', () => {
  const body = {
    auto: false,
    future: 'ignored',
    models: [
      { key: 'Bad Key', label: 'Bad', levels: [], defaultLevel: null },
      {
        key: 'gpt-7',
        label: 'GPT-7',
        badge: 'new',
        levels: [
          { key: 'low', label: 'Low' },
          { key: 'LOUD', label: 'Loud' },
          { key: 'max', label: '' },
          { key: 'high', label: 'High', hint: 'ignored' },
        ],
        defaultLevel: 'max',
      },
      { key: 'gpt-7', label: 'Duplicate', levels: [], defaultLevel: null },
      { key: 'kimi', label: 'Kimi K3', levels: 'none', defaultLevel: null },
    ],
  };
  expect(parseCatalog(JSON.stringify(body))).toEqual({
    auto: false,
    models: [
      {
        key: 'gpt-7',
        label: 'GPT-7',
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
