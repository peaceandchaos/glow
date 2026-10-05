const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join, relative } = require('node:path');
const ts = require('typescript');
const { z } = require('zod');
const { git } = require('../verification/snapshot.cjs');
const { changeSubject, globPattern } = require('./routing.cjs');

const ledgerPath = 'tools/skills/ledger.json';
const testCase = { file: z.string().min(1), name: z.string().min(1) };
const enforcement = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('guidance') }),
  z.strictObject({ kind: z.literal('type'), ...testCase }),
  z.strictObject({ kind: z.literal('test'), ...testCase }),
  z.strictObject({ kind: z.literal('lint'), rule: z.string().min(1) }),
  z.strictObject({ kind: z.literal('check'), check: z.string().min(1) }),
]);
const ledgerSchema = z.strictObject({
  lessons: z.array(
    z.strictObject({
      id: z.string().regex(/^[a-z0-9-]+$/u),
      lesson: z.string().min(1),
      seen: z.array(z.string().min(1)).min(1),
      enforcement,
      paths: z.array(z.string().min(1)).min(1).optional(),
      link: z.string().min(1).optional(),
    }),
  ),
});

function readLedger(root) {
  return ledgerSchema.parse(
    JSON.parse(readFileSync(join(root, ledgerPath), 'utf8')),
  );
}

function isNamedTest(node, name) {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression))
    return false;
  const [title] = node.arguments;
  return (
    ['test', 'it'].includes(node.expression.text) &&
    title !== undefined &&
    ts.isStringLiteralLike(title) &&
    title.text === name
  );
}

function isDisabledBlock(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'xdescribe';
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'describe' &&
    callee.name.text === 'skip'
  );
}

function definesTest(path, name) {
  const visit = node =>
    !isDisabledBlock(node) &&
    (isNamedTest(node, name) || ts.forEachChild(node, visit));
  const text = readFileSync(path, 'utf8');
  return Boolean(
    visit(ts.createSourceFile(path, text, ts.ScriptTarget.Latest)),
  );
}

function discoveredTests(root) {
  const jest = require.resolve('jest/bin/jest');
  const configs = git(root, ['ls-files'])
    .split('\n')
    .filter(path => /(?:^|\/)jest\.config\.[cm]?js$/u.test(path));
  const found = new Set();
  for (const config of configs) {
    const listed = execFileSync(
      process.execPath,
      [jest, '--listTests', '--json', '--config', join(root, config)],
      { cwd: root, encoding: 'utf8' },
    );
    for (const path of JSON.parse(listed)) found.add(relative(root, path));
  }
  return found;
}

function enforcementProblem(root, { enforcement: rule }, discovered) {
  if (rule.kind === 'guidance') return null;
  if (rule.kind === 'check') {
    const { checks, rangeChecks } = require(
      join(root, 'tools/verification/checks.cjs'),
    );
    return Object.hasOwn(checks, rule.check) ||
      Object.hasOwn(rangeChecks, rule.check)
      ? null
      : `names check ${rule.check}, which tools/verification/checks.cjs does not run`;
  }
  if (rule.kind === 'lint') {
    const config = JSON.parse(
      readFileSync(join(root, '.oxlintrc.json'), 'utf8'),
    );
    const setting = Object.hasOwn(config.rules, rule.rule)
      ? [config.rules[rule.rule]].flat()[0]
      : undefined;
    return setting !== undefined && setting !== 'off' && setting !== 0
      ? null
      : `names lint rule ${rule.rule}, which .oxlintrc.json does not enable`;
  }
  const path = join(root, rule.file);
  if (!existsSync(path) || !definesTest(path, rule.name))
    return `names test '${rule.name}', which ${rule.file} does not contain`;
  return discovered().has(rule.file)
    ? null
    : `names test '${rule.name}' in ${rule.file}, which no tracked Jest config discovers`;
}

function linkProblem(root, link) {
  if (link === undefined || /^https:\/\/\S+$/u.test(link)) return null;
  return git(root, ['ls-files', '--', link])
    ? null
    : `links ${link}, which is neither an https URL nor a tracked file`;
}

function ledgerProblems(root, ledger) {
  const problems = [];
  const ids = new Set();
  let found;
  const discovered = () => (found ??= discoveredTests(root));
  for (const entry of ledger.lessons) {
    if (ids.has(entry.id)) problems.push(`${entry.id} appears twice.`);
    ids.add(entry.id);
    for (const problem of [
      enforcementProblem(root, entry, discovered),
      linkProblem(root, entry.link),
    ])
      if (problem) problems.push(`${entry.id} ${problem}.`);
    if (
      entry.enforcement.kind === 'guidance' &&
      entry.seen.length >= 2 &&
      !entry.link
    )
      problems.push(
        `${entry.id} is guidance only and was seen ${entry.seen.length} times. Enforce it with a type, test, lint rule, or check, or link the issue or decision that keeps it as guidance.`,
      );
  }
  return problems;
}

function lessonsFor(ledger, change) {
  const paths = change.files.flatMap(file =>
    [file.path, file.from].filter(Boolean),
  );
  const lessons = [];
  const enforced = [];
  for (const entry of ledger.lessons) {
    if (entry.enforcement.kind !== 'guidance') {
      enforced.push(entry.id);
      continue;
    }
    const patterns = entry.paths?.map(globPattern);
    const files = patterns
      ? paths.filter(path => patterns.some(glob => glob.test(path)))
      : paths.length
        ? [changeSubject]
        : [];
    if (files.length)
      lessons.push({ entry, files: [...new Set(files)].sort() });
  }
  return { lessons, enforced: enforced.sort() };
}

module.exports = { ledgerPath, readLedger, ledgerProblems, lessonsFor };
