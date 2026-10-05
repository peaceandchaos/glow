const { spawnSync } = require('node:child_process');
const {
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  rmdirSync,
} = require('node:fs');
const { join, resolve } = require('node:path');

const app = resolve(__dirname, '../..');
const directory = join(app, 'tools/fixtures/lint-policy');
const fixtures = join(app, 'tools/fixtures');
const fixturesExisted = existsSync(fixtures);
const executable = join(app, 'node_modules/oxlint/bin/oxlint');
const configFile = join(app, '.lint-policy-test.json');

beforeAll(() => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ['input.ts'],
    }),
  );
  const config = require('../../.oxlintrc.json');
  writeFileSync(configFile, JSON.stringify({ ...config, ignorePatterns: [] }));
});
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
  rmSync(configFile, { force: true });
  // Remove only an empty parent created by this test; preserve existing fixtures.
  if (!fixturesExisted) rmdirSync(fixtures);
});

function lint(source, config = configFile) {
  const file = join(directory, 'input.ts');
  writeFileSync(file, source);
  return spawnSync(
    process.execPath,
    [executable, '--config', config, '--deny-warnings', '--no-ignore', file],
    {
      cwd: app,
      encoding: 'utf8',
    },
  );
}

test.each([
  [
    'no-unknown-parameters',
    'export function pass(value: unknown) { return value; }',
  ],
  ['no-unknown-returns', 'export function pass(): unknown { return 1; }'],
  ['no-unknown-type-aliases', 'export type Data = unknown;'],
  ['no-unsafe-dictionary-type', 'export type Data = Record<string, unknown>;'],
  [
    'no-object-parameters',
    'export function pass(value: object) { return value; }',
  ],
  [
    'no-chained-type-assertions',
    'export const value = 1 as unknown as string;',
  ],
  [
    'require-safety-comment-for-type-assertion',
    "export const value = JSON.parse('1') as number;",
  ],
  [
    'no-widen-then-assert',
    "const source = { id: 'second' }; const widened: unknown = source; export const parsed = widened as { readonly id: string };",
  ],
  ['no-known-value-widening', 'export const value: unknown = {};'],
  [
    'no-array-filter-map',
    'export const values = [1, 2].filter(value => value > 1).map(value => value * 2);',
  ],
  [
    'no-reduce-accumulator-copy',
    'export const values = [1, 2].reduce<number[]>((result, value) => result.concat(value), []);',
  ],
  ['no-reflect-get', "export const value = Reflect.get({ id: 1 }, 'id');"],
  [
    'no-reflect-apply',
    'export const value = Reflect.apply(Math.max, null, [1, 2]);',
  ],
  ['no-explicit-any', 'export let value: any = 1;'],
  ['no-floating-promises', 'async function run() { return 1; } run();'],
  [
    'require-disable-reason',
    '// oxlint-disable-next-line anti-slop/no-unknown-parameters\nexport function decode(raw: unknown) { return raw; }',
  ],
  [
    'no-abusive-eslint-disable',
    '// eslint-disable -- No named rule\nexport const value = 1;',
  ],
])('rejects %s', (rule, source) => {
  const result = lint(source);
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).toContain(rule);
});

test.each([
  ['an as', "export const value = JSON.parse('1') as number;"],
  ['an angle-bracket', "export const value = <number>JSON.parse('1');"],
  ['a non-null', 'export const first = [1].at(0)!;'],
  ['a definite-assignment', 'export let value!: number;'],
  ['a definite-property', 'export class Box { value!: number; }'],
])('rejects %s type assertion', (_kind, source) => {
  const result = lint(source);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('project(no-type-assertion)');
});

test.each([
  [
    'a next-line',
    "// oxlint-disable-next-line project/no-type-assertion -- Trusted value.\nexport const value = JSON.parse('1') as number;",
  ],
  [
    'a file-wide eslint',
    "/* eslint-disable project/no-type-assertion -- Trusted file. */\nexport const value = JSON.parse('1') as number;",
  ],
  [
    'a combined',
    "// oxlint-disable project/require-disable-reason, project/no-type-assertion -- Trusted file.\nexport const value = JSON.parse('1') as number;",
  ],
])('rejects %s disable of project/no-type-assertion', (_kind, source) => {
  const result = lint(source);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain(
    "List a reviewed boundary file in project/no-type-assertion's allow option",
  );
});

test('allows const assertions, and assertions in a listed boundary file', () => {
  expect(lint("export const modes = ['a', 'b'] as const;").status).toBe(0);
  const config = require('../../.oxlintrc.json');
  const listed = join(app, '.lint-policy-allow-test.json');
  writeFileSync(
    listed,
    JSON.stringify({
      ...config,
      ignorePatterns: [],
      rules: {
        ...config.rules,
        'anti-slop/require-safety-comment-for-type-assertion': 'off',
        'project/no-type-assertion': [
          'error',
          {
            allow: [
              {
                file: 'tools/fixtures/lint-policy/input.ts',
                reason: 'Fixture boundary.',
              },
            ],
          },
        ],
      },
    }),
  );
  try {
    const source =
      'export function widen(value: number) { return value as number | string; }';
    expect(lint(source).stdout).toContain('project(no-type-assertion)');
    expect(lint(source, listed).status).toBe(0);
  } finally {
    rmSync(listed, { force: true });
  }
});

test('rejects assertions when the rule is enabled without options', () => {
  const config = require('../../.oxlintrc.json');
  const bare = join(app, '.lint-policy-bare-test.json');
  writeFileSync(
    bare,
    JSON.stringify({
      ...config,
      ignorePatterns: [],
      rules: { ...config.rules, 'project/no-type-assertion': 'error' },
    }),
  );
  try {
    const result = lint('export const first = [1].at(0)!;', bare);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('project(no-type-assertion)');
  } finally {
    rmSync(bare, { force: true });
  }
});

test('allows a documented raw-input decoder exception', () => {
  const result = lint(
    [
      '// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Decode untrusted network input at this boundary.',
      'export function decode(raw: unknown): string {',
      "  if (typeof raw !== 'string') throw new Error('Expected text');",
      '  return raw;',
      '}',
    ].join('\n'),
  );
  expect(result.status).toBe(0);
});

test('keeps the selected plugins and rule severities', () => {
  const config = require('../../.oxlintrc.json');
  expect(config.options.typeAware).toBe(true);
  expect(config.jsPlugins.map(plugin => plugin.name)).toEqual([
    'anti-slop',
    'project',
  ]);
  expect(
    Object.values(config.rules).every(
      value => value === 'error' || value[0] === 'error',
    ),
  ).toBe(true);
  expect(config.plugins).not.toContain('react-perf');
  expect(config.plugins).not.toContain('vitest');
});
