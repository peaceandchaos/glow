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

const tool = resolve(__dirname, '../range-typecheck.cjs');
let repository;
const commits = {};

function write(path, text) {
  mkdirSync(dirname(join(repository, path)), { recursive: true });
  writeFileSync(join(repository, path), text);
}

function commit(name, message) {
  git(repository, ['add', '--all']);
  git(repository, ['commit', '--quiet', '-m', message]);
  commits[name] = git(repository, ['rev-parse', 'HEAD']);
}

function manifest(description) {
  return JSON.stringify({
    name: 'fixture',
    version: '1.0.0',
    description,
    scripts: { typecheck: 'node check.cjs' },
  });
}

beforeAll(() => {
  repository = realpathSync(mkdtempSync(join(tmpdir(), 'range-types-')));
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'core.hooksPath', '/dev/null']);
  git(repository, ['config', 'user.name', 'Range fixture']);
  git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  write('package.json', manifest('Base.'));
  write(
    'package-lock.json',
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': { name: 'fixture', version: '1.0.0' } },
    }),
  );
  write('packages/app/src/config.example.ts', 'export {};\n');
  write(
    'check.cjs',
    "const text = require('node:fs').readFileSync('source.txt', 'utf8');\nif (text.includes('broken')) {\n  console.error('source.txt does not typecheck.');\n  process.exit(2);\n}\n",
  );
  write('source.txt', 'ok\n');
  commit('base', 'Base');
  write('source.txt', 'broken\n');
  commit('broken', 'feat: break the source');
  write('source.txt', 'ok again\n');
  commit('repaired', 'fix: repair the source');
  write('package.json', manifest('Changed.'));
  commit('reinstalled', 'build: describe the package');
  write('source.txt', 'broken at head\n');
  commit('head', 'docs: leave the head to the types check');
  mkdirSync(join(repository, 'node_modules'));
});

afterAll(() => rmSync(repository, { recursive: true, force: true }));

function typecheckRange(...range) {
  return spawnSync(process.execPath, [tool, ...range], {
    cwd: repository,
    encoding: 'utf8',
  });
}

const short = name => commits[name].slice(0, 12);

test('fails on an intermediate commit that does not typecheck', () => {
  const result = typecheckRange(commits.base);
  expect(result.status).toBe(1);
  const lines = result.stdout.split('\n');
  expect(lines[0]).toBe(
    `Typecheck of 3 commits other than HEAD in ${short('base')}..${short('head')}:`,
  );
  expect(lines[1]).toBe(
    `${short('broken')} feat: break the source: FAIL (own install)`,
  );
  expect(result.stdout).toContain('source.txt does not typecheck.');
  expect(lines.slice(-3)).toEqual([
    `${short('repaired')} fix: repair the source: PASS (shared install)`,
    `${short('reinstalled')} build: describe the package: PASS (shared install)`,
    '',
  ]);
});

test('passes when every commit before the head typechecks', () => {
  const result = typecheckRange(commits.broken);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(
    [
      `Typecheck of 2 commits other than HEAD in ${short('broken')}..${short('head')}:`,
      `${short('repaired')} fix: repair the source: PASS (own install)`,
      `${short('reinstalled')} build: describe the package: PASS (shared install)`,
      '',
    ].join('\n'),
  );
});

test('checks a named head that is not HEAD', () => {
  const result = typecheckRange(commits.base, commits.broken);
  expect(result.status).toBe(1);
  expect(result.stdout.split('\n').slice(0, 2)).toEqual([
    `Typecheck of 1 commits other than HEAD in ${short('base')}..${short('broken')}:`,
    `${short('broken')} feat: break the source: FAIL (own install)`,
  ]);
});
