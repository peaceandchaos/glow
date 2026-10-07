const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { git } = require('../verification/snapshot.cjs');
const { trackedIgnored } = require('../ignored-check.cjs');
const { scannerSkips, scannerGaps } = require('../security-check.cjs');

test('the ignored-file check lists tracked files under ignored paths only', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'ignored-fixture-'));
  try {
    git(fixture, ['init', '--quiet']);
    mkdirSync(join(fixture, 'src/build'), { recursive: true });
    writeFileSync(join(fixture, '.gitignore'), 'build/\n');
    writeFileSync(join(fixture, 'personal-ignore'), 'src/plain.ts\n');
    git(fixture, ['config', 'core.excludesFile', 'personal-ignore']);
    for (const file of ['src/plain.ts', 'src/build/hidden.ts'])
      writeFileSync(join(fixture, file), 'export const probe = 1;\n');
    git(fixture, ['add', '--force', '.gitignore', 'src/plain.ts']);
    expect(trackedIgnored(fixture)).toEqual([]);
    git(fixture, ['add', '--force', 'src/build/hidden.ts']);
    expect(trackedIgnored(fixture)).toEqual(['src/build/hidden.ts']);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the scanner-skip list matches rnsec's own ignore list", () => {
  const walker = readFileSync(
    join(
      dirname(require.resolve('rnsec/package.json')),
      'dist/core/fileWalker.js',
    ),
    'utf8',
  );
  const list = /const defaultIgnore = \[([^\]]*)\]/u.exec(walker)[1];
  expect([...list.matchAll(/'([^']+)'/gu)].map(match => match[1])).toEqual(
    scannerSkips,
  );
});

test('the security check fails source in a path that rnsec skips', () => {
  const hidden = [
    'packages/app/src/e2e/token.ts',
    'packages/app/src/dist/token.tsx',
    'packages/app/src/test/token.js',
    'packages/app/src/__mocks__/token.jsx',
    'packages/app/src/token.spec.ts',
    'packages/app/src/token.test.tsx',
    'packages/server/src/build/token.ts',
  ];
  const scanned = [
    'packages/app/src/plain/token.ts',
    'packages/app/src/e2e/notes.md',
    'packages/app/__tests__/token.test.tsx',
    'packages/server/tests/fixtures.ts',
    'tools/__tests__/token.test.js',
  ];
  expect(scannerGaps([...scanned, ...hidden])).toEqual(hidden);
});
