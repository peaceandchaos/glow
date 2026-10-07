const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { git } = require('../verification/snapshot.cjs');
const { trackedIgnored } = require('../ignored-check.cjs');

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
