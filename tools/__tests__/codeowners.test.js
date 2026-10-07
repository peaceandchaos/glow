const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { globPattern } = require('../skills/routing.cjs');
const routing = require('../skills/routing.json');

const repo = resolve(__dirname, '../..');
const owner = '@peaceandchaos';
const records = 'tools/skills/records/';
const sourceDirs = [
  'packages/app/src/',
  'packages/app/__tests__/',
  'packages/app/harness/',
  'packages/app/assets/',
  'packages/app/ios/',
  'packages/server/src/',
  'packages/server/workflows/',
  'packages/server/tests/',
  'packages/server/scripts/',
  'shared/',
  records,
];

function codeownersPattern(pattern) {
  const anchored =
    pattern.startsWith('/') || pattern.slice(0, -1).includes('/');
  const directory = pattern.endsWith('/');
  const body = pattern.replace(/^\//u, '').replace(/\/$/u, '');
  const glob = globPattern(body).source.slice(1, -1);
  return new RegExp(
    `^${anchored ? '' : '(?:.*/)?'}${glob}${directory ? '/.*' : '(?:/.*)?'}$`,
    'u',
  );
}

const entries = readFileSync(resolve(repo, '.github/CODEOWNERS'), 'utf8')
  .split('\n')
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#'))
  .map(line => {
    const [pattern, ...owners] = line.split(/\s+/u);
    return { pattern: codeownersPattern(pattern), owners };
  });

// GitHub applies the last matching CODEOWNERS line, and a line without owners clears them.
const isOwned = file =>
  entries.findLast(entry => entry.pattern.test(file))?.owners.includes(owner) ??
  false;

const controls = routing.rules.find(rule => rule.id === 'controls');
const isControl = file =>
  controls.paths.some(glob => globPattern(glob).test(file)) &&
  !controls.excludePaths.some(glob => globPattern(glob).test(file));

const tracked = execFileSync('git', ['ls-files'], {
  cwd: repo,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);
const configs = [
  '.npmrc',
  'packages/server/src/.gitignore',
  'packages/app/src/.npmrc',
  'packages/app/src/.eslintignore',
  'packages/server/.prettierignore',
  'packages/app/src/.oxlintrc.json',
  'packages/server/nitro.config.ts',
  'packages/app/ios/Podfile',
  'packages/app/ios/Podfile.lock',
  'packages/app/ios/.xcode.env',
  'packages/app/__tests__/.oxlintrc.json',
  'packages/server/tests/jest.config.js',
  'packages/server/scripts/package.json',
  'shared/tsconfig.json',
  'packages/app/src/.cache/rules.json',
  'packages/app/.rnsec.jsonc',
  'packages/server/Gemfile.lock',
];
const added = ['docs/new.md', 'packages/app/android/build.gradle.kts'];
const sources = [
  'packages/app/src/screens/ChatScreen.tsx',
  'packages/server/src/api.ts',
  'packages/app/ios/MargeloChat.xcodeproj/project.pbxproj',
  'shared/contracts.ts',
];

test('the owner owns every file outside the source directories', () => {
  const outside = [...tracked, ...added].filter(
    file => !sourceDirs.some(dir => file.startsWith(dir)),
  );
  expect(outside.length).toBeGreaterThan(100);
  expect(outside.filter(file => !isOwned(file))).toEqual([]);
});

test.each(configs)('the owner owns the dotfile or config %s', file => {
  expect(isOwned(file)).toBe(true);
});

test.each([...sources, `${records}control-paths.json`])(
  '%s has no code owner',
  file => {
    expect(isOwned(file)).toBe(false);
  },
);

test('the controls rule routes exactly the owned files outside records', () => {
  const files = [
    ...new Set([...tracked, ...added, ...configs, ...sources]),
  ].filter(file => !file.startsWith(records));
  expect(files.filter(file => isOwned(file) !== isControl(file))).toEqual([]);
});
