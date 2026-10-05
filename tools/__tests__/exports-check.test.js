const { spawnSync } = require('node:child_process');
const {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { git } = require('../verification/snapshot.cjs');

const tool = resolve(__dirname, '../exports-check.cjs');
const entriesPath = 'tools/verification/export-entries.json';
let repository;

function write(path, text) {
  mkdirSync(dirname(join(repository, path)), { recursive: true });
  writeFileSync(join(repository, path), text);
}

function entries(files, exports) {
  write(
    entriesPath,
    JSON.stringify({ projects: ['app/tsconfig.json'], files, exports }),
  );
}

function check() {
  return spawnSync(process.execPath, [tool], {
    cwd: repository,
    encoding: 'utf8',
  });
}

beforeAll(() => {
  repository = realpathSync(mkdtempSync(join(tmpdir(), 'exports-fixture-')));
  git(repository, ['init', '--quiet']);
  write(
    'app/tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: 'ESNext',
        moduleResolution: 'Bundler',
      },
      include: ['**/*.ts'],
    }),
  );
  write(
    'app/main.ts',
    [
      "import * as math from './math';",
      "import { type Shape } from './shapes';",
      "export { label } from './labels';",
      "export type Lazy = typeof import('./lazy').later;",
      'export const area = (shape: Shape) => math.square(shape.side);',
      "export const load = () => import('./loaded');",
      '',
    ].join('\n'),
  );
  write(
    'app/math.ts',
    'export const square = (side: number) => side * side;\n',
  );
  write(
    'app/shapes.ts',
    'export type Shape = { side: number };\nexport const unit: Shape = { side: 1 };\n',
  );
  write('app/labels.ts', "export const label = 'area';\n");
  write('app/lazy.ts', 'export const later = 1;\nexport const never = 2;\n');
  write('app/loaded.ts', 'export const loaded = true;\n');
  write('app/plain.ts', 'const hidden = 1;\nconsole.log(hidden);\n');
  write(
    'app/tool.ts',
    'export const runTool = () => 1;\nexport const spareTool = () => 2;\n',
  );
  write('app/helper.ts', 'export const help = 1;\nexport const more = 2;\n');
  write(
    'scripts/run.mjs',
    "import { runTool } from '../app/tool.ts';\nrunTool();\n",
  );
  write(
    'scripts/load.cjs',
    "const helper = require('../app/helper');\nconsole.log(helper);\n",
  );
  git(repository, ['add', '--all']);
  write(
    'scripts/untracked.mjs',
    "import { spareTool } from '../app/tool.ts';\nspareTool();\n",
  );
  write(
    'app/untracked.ts',
    "import { never } from './lazy';\nexport const x = never;\n",
  );
});

afterAll(() => rmSync(repository, { recursive: true, force: true }));

test('passes when every tracked export is imported or listed with a reason', () => {
  entries(
    [{ path: 'app/main.ts', reason: 'The entry point.' }],
    [
      { file: 'app/lazy.ts', name: 'never', reason: 'Kept for a branch.' },
      { file: 'app/shapes.ts', name: 'unit', reason: 'Kept for a branch.' },
      { file: 'app/tool.ts', name: 'spareTool', reason: 'Kept for a branch.' },
    ],
  );
  const result = check();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(
    'Every export is imported or listed as an entry.\n',
  );
});

test('reports unused exports and stale entries', () => {
  entries(
    [
      { path: 'app/plain.ts', reason: 'Has no exports.' },
      { path: 'app/gone.ts', reason: 'Was deleted.' },
    ],
    [
      { file: 'app/math.ts', name: 'square', reason: 'Imported now.' },
      { file: 'app/shapes.ts', name: 'circle', reason: 'Never existed.' },
    ],
  );
  const result = check();
  expect(result.stdout).toBe('');
  expect(result.status).toBe(1);
  expect(result.stderr).toBe(
    [
      'Unused exports fail. Import the export, stop exporting it, or list it with a reason in tools/verification/export-entries.json:',
      `${entriesPath}: app/plain.ts is listed as an entry point but is not a source file with exports.`,
      `${entriesPath}: app/gone.ts is listed as an entry point but is not a source file with exports.`,
      `${entriesPath}: app/math.ts square is imported now; remove its entry.`,
      `${entriesPath}: app/shapes.ts does not export circle.`,
      'app/lazy.ts: never is exported but never imported.',
      'app/main.ts: Lazy is exported but never imported.',
      'app/main.ts: area is exported but never imported.',
      'app/main.ts: label is exported but never imported.',
      'app/main.ts: load is exported but never imported.',
      'app/shapes.ts: unit is exported but never imported.',
      'app/tool.ts: spareTool is exported but never imported.',
      '',
    ].join('\n'),
  );
});

test('rejects an entry without a reason', () => {
  entries([{ path: 'app/main.ts' }], []);
  const result = check();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('"reason"');
});
