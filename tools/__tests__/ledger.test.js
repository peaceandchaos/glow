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

const cli = resolve(__dirname, '../skills/cli.cjs');
const ledgerPath = 'tools/skills/ledger.json';
let repository;

function write(path, text) {
  mkdirSync(dirname(join(repository, path)), { recursive: true });
  writeFileSync(join(repository, path), text);
}

function lesson(id, enforcement, extra = {}) {
  return {
    id,
    lesson: `Lesson ${id}.`,
    seen: ['a run'],
    enforcement,
    ...extra,
  };
}

function ledger(lessons) {
  write(ledgerPath, JSON.stringify({ lessons }));
  return spawnSync(process.execPath, [cli, 'ledger'], {
    cwd: repository,
    encoding: 'utf8',
  });
}

beforeAll(() => {
  repository = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-fixture-')));
  git(repository, ['init', '--quiet']);
  write(
    'tools/verification/checks.cjs',
    "module.exports = { checks: { lint: ['run', 'lint'] }, rangeChecks: { 'commit-types': ['run', 'typecheck:range', '--'] } };\n",
  );
  write(
    '.oxlintrc.json',
    JSON.stringify({
      rules: {
        'project/rule': ['error', { allow: [] }],
        'project/off': 'off',
      },
    }),
  );
  write(
    'jest.config.cjs',
    "module.exports = { testMatch: ['<rootDir>/tests/**/*.test.ts'] };\n",
  );
  write(
    'tests/sizes.test.ts',
    [
      "test('a named case', () => {});",
      "it('a type case', () => {});",
      "// test('a commented case', () => {});",
      "test.skip('a skipped case', () => {});",
      "export const label = 'a string case';",
      "describe('a block', () => { test('a nested case', () => {}); });",
      "describe.skip('a skipped block', () => { test('a case in a skipped block', () => {}); });",
      "xdescribe('an x block', () => { it('a case in an x block', () => {}); });",
      "xit('an x case', () => {});",
      "xtest('another x case', () => {});",
      '',
    ].join('\n'),
  );
  write('notes/sizes.test.ts', "test('an undiscovered case', () => {});\n");
  write('docs/decision.md', '# Keep this as guidance\n');
  git(repository, ['add', '--all']);
  write('docs/draft.md', '# Not tracked\n');
});

afterAll(() => rmSync(repository, { recursive: true, force: true }));

const sizes = name => ({ file: 'tests/sizes.test.ts', name });

test('passes when every enforcement exists and repeated guidance links a decision', () => {
  const result = ledger([
    lesson('once', { kind: 'guidance' }),
    lesson(
      'decided',
      { kind: 'guidance' },
      { seen: ['a run', 'another run'], link: 'docs/decision.md' },
    ),
    lesson(
      'tracked',
      { kind: 'guidance' },
      { seen: ['a', 'b', 'c'], link: 'https://example.invalid/issues/1' },
    ),
    lesson('checked', { kind: 'check', check: 'lint' }),
    lesson('ranged', { kind: 'check', check: 'commit-types' }),
    lesson('linted', { kind: 'lint', rule: 'project/rule' }),
    lesson('tested', { kind: 'test', ...sizes('a named case') }),
    lesson('nested', { kind: 'test', ...sizes('a nested case') }),
    lesson('typed', { kind: 'type', ...sizes('a type case') }),
  ]);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(
    `${ledgerPath} has no guidance-only lesson that needs promotion.\n`,
  );
});

test('fails on repeated unlinked guidance, stale enforcement, bad links, and duplicate ids', () => {
  const result = ledger([
    lesson(
      'repeated',
      { kind: 'guidance' },
      { seen: ['a run', 'another run'] },
    ),
    lesson('gone-check', { kind: 'check', check: 'retired' }),
    lesson('inherited-check', { kind: 'check', check: 'constructor' }),
    lesson('gone-rule', { kind: 'lint', rule: 'project/retired' }),
    lesson('inherited-rule', { kind: 'lint', rule: 'toString' }),
    lesson('off-rule', { kind: 'lint', rule: 'project/off' }),
    lesson('gone-test', { kind: 'test', ...sizes('a renamed case') }),
    lesson('commented-test', { kind: 'test', ...sizes('a commented case') }),
    lesson('skipped-test', { kind: 'test', ...sizes('a skipped case') }),
    lesson('skipped-block', {
      kind: 'test',
      ...sizes('a case in a skipped block'),
    }),
    lesson('x-block', { kind: 'test', ...sizes('a case in an x block') }),
    lesson('x-it', { kind: 'test', ...sizes('an x case') }),
    lesson('x-test', { kind: 'test', ...sizes('another x case') }),
    lesson('undiscovered', {
      kind: 'test',
      file: 'notes/sizes.test.ts',
      name: 'an undiscovered case',
    }),
    lesson('string-type', { kind: 'type', ...sizes('a string case') }),
    lesson('gone-file', {
      kind: 'type',
      file: 'tests/gone.test.ts',
      name: 'x',
    }),
    lesson('draft', { kind: 'guidance' }, { link: 'docs/draft.md' }),
    lesson('repeated', { kind: 'check', check: 'lint' }),
  ]);
  expect(result.stdout).toBe('');
  expect(result.status).toBe(1);
  expect(result.stderr).toBe(
    [
      `${ledgerPath} fails:`,
      'repeated is guidance only and was seen 2 times. Enforce it with a type, test, lint rule, or check, or link the issue or decision that keeps it as guidance.',
      'gone-check names check retired, which tools/verification/checks.cjs does not run.',
      'inherited-check names check constructor, which tools/verification/checks.cjs does not run.',
      'gone-rule names lint rule project/retired, which .oxlintrc.json does not enable.',
      'inherited-rule names lint rule toString, which .oxlintrc.json does not enable.',
      'off-rule names lint rule project/off, which .oxlintrc.json does not enable.',
      "gone-test names test 'a renamed case', which tests/sizes.test.ts does not contain.",
      "commented-test names test 'a commented case', which tests/sizes.test.ts does not contain.",
      "skipped-test names test 'a skipped case', which tests/sizes.test.ts does not contain.",
      "skipped-block names test 'a case in a skipped block', which tests/sizes.test.ts does not contain.",
      "x-block names test 'a case in an x block', which tests/sizes.test.ts does not contain.",
      "x-it names test 'an x case', which tests/sizes.test.ts does not contain.",
      "x-test names test 'another x case', which tests/sizes.test.ts does not contain.",
      "undiscovered names test 'an undiscovered case' in notes/sizes.test.ts, which no tracked Jest config discovers.",
      "string-type names test 'a string case', which tests/sizes.test.ts does not contain.",
      "gone-file names test 'x', which tests/gone.test.ts does not contain.",
      'draft links docs/draft.md, which is neither an https URL nor a tracked file.',
      'repeated appears twice.',
      '',
    ].join('\n'),
  );
});

test('rejects a lesson without a sighting or with an unknown enforcement', () => {
  const unseen = ledger([lesson('unseen', { kind: 'guidance' }, { seen: [] })]);
  expect(unseen.status).toBe(1);
  expect(unseen.stderr).toContain('"seen"');
  const unknown = ledger([lesson('vague', { kind: 'review' })]);
  expect(unknown.status).toBe(1);
  expect(unknown.stderr).toContain('"kind"');
});
