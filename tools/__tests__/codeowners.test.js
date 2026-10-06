const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { globPattern } = require('../skills/routing.cjs');
const routing = require('../skills/routing.json');

const repo = resolve(__dirname, '../..');
const owner = '@peaceandchaos';

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
function ownersOf(file) {
  let owners = [];
  for (const entry of entries)
    if (entry.pattern.test(file)) owners = entry.owners;
  return owners;
}

const controls = routing.rules.find(rule => rule.id === 'controls');
const isControl = file =>
  controls.paths.some(glob => globPattern(glob).test(file)) &&
  !controls.excludePaths.some(glob => globPattern(glob).test(file));

test('the owner owns every tracked file that the controls rule routes', () => {
  const tracked = execFileSync('git', ['ls-files'], {
    cwd: repo,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  const controlFiles = tracked.filter(isControl);
  expect(controlFiles.length).toBeGreaterThan(0);
  expect(controlFiles.filter(file => !ownersOf(file).includes(owner))).toEqual(
    [],
  );
});

test.each([
  'packages/app/.rnsec.json',
  'packages/app/.rnsec.jsonc',
  'packages/app/src/.oxlintrc.json',
  'packages/server/.oxfmtrc.json',
  'packages/app/metro.config.js',
  'packages/app/ios/Podfile',
  'packages/app/ios/Podfile.lock',
  'packages/app/Gemfile',
  'packages/server/Gemfile.lock',
  'packages/app/.bundle/config',
])('%s is a control path and the owner owns it', file => {
  expect({ control: isControl(file), owners: ownersOf(file) }).toEqual({
    control: true,
    owners: [owner],
  });
});

test.each([
  'packages/app/src/screens/ChatScreen.tsx',
  'packages/app/ios/MargeloChat.xcodeproj/project.pbxproj',
  'tools/skills/records/control-paths.json',
])('%s has no code owner', file => {
  expect(ownersOf(file)).toEqual([]);
});
