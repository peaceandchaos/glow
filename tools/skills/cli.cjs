const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join, relative, resolve } = require('node:path');
const { git } = require('../verification/snapshot.cjs');
const { readPlan, readRange } = require('./change.cjs');
const {
  ledgerPath,
  ledgerProblems,
  lessonsFor,
  readLedger,
} = require('./ledger.cjs');
const { buildLock, lockPath, readLock } = require('./catalog.cjs');
const { checkSkillCopies } = require('./doctor.cjs');
const { parseReceipts, readPublicKey } = require('./receipts.cjs');
const { checkRecords, workingReader, writeRecord } = require('./records.cjs');
const {
  loadInstruction,
  parseRouting,
  receiptStep,
  requiredSkills,
  resolveSkill,
  routingPath,
} = require('./routing.cjs');

const oxfmt = resolve(__dirname, '../../node_modules/.bin/oxfmt');
const usage = `Usage:
  npm run skills:required -- <base> [<head>]
  npm run skills:required -- --plan <path>|A:<path>|D:<path>|R:<old>:<new> ...
  npm run skills:catalog [-- --lock]
  npm run skills:record -- <change-id> <base> [<head>] [--review]
  npm run skills:check -- <base> [<head>]
  npm run skills:ledger
  npm run skills:doctor`;

function readRouting(root) {
  return parseRouting(readFileSync(join(root, routingPath), 'utf8'));
}

function describe(change) {
  const files = `${change.files.length} files`;
  if (change.kind === 'plan')
    return `Required skills for a planned change of ${files}.`;
  return `Required skills for ${change.base.slice(0, 12)}..${change.head.slice(0, 12)} (merge base to head): ${files}.`;
}

function printRequired(root, routing, change) {
  const { tier, required, skipped, skippedTiers } = requiredSkills(
    routing,
    change,
  );
  const lines = [describe(change)];
  if (tier)
    lines.push(
      `Tier ${tier.id} replaces ${tier.replaces.join(', ')}: ${tier.why}`,
    );
  const unevaluated = [];
  if (skipped.length)
    unevaluated.push(`these rules were not evaluated: ${skipped.join(', ')}`);
  if (skippedTiers.length)
    unevaluated.push(
      `these tiers were not evaluated: ${skippedTiers.join(', ')}`,
    );
  if (unevaluated.length)
    lines.push(`A plan has no content, so ${unevaluated.join('; and ')}.`);
  if (!required.length) lines.push('No skills are required.');
  for (const { skill, reasons } of required) {
    const file = resolveSkill(routing, skill, process.env, root);
    lines.push(
      '',
      skill,
      `  ${loadInstruction(routing, skill, file, readFileSync(file, 'utf8'))}`,
    );
    for (const { rule, why, matches } of reasons) {
      lines.push(`  ${rule}: ${why}`);
      for (const { subject, detail } of matches)
        lines.push(`    ${subject}${detail ? ` (${detail})` : ''}`);
    }
  }
  const { lessons, enforced } = lessonsFor(readLedger(root), change);
  if (lessons.length) lines.push('', `Lessons from ${ledgerPath}:`);
  for (const { entry, files } of lessons) {
    const times =
      entry.seen.length === 1 ? 'once' : `${entry.seen.length} times`;
    lines.push(`  ${entry.id} (seen ${times}): ${entry.lesson}`);
    for (const file of files) lines.push(`    ${file}`);
  }
  if (enforced.length)
    lines.push('', `Enforced, so not listed: ${enforced.join(', ')}.`);
  console.log(lines.join('\n'));
}

function checkLedger(root) {
  const problems = ledgerProblems(root, readLedger(root));
  if (problems.length) {
    console.error([`${ledgerPath} fails:`, ...problems].join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(
    `${ledgerPath} has no guidance-only lesson that needs promotion.`,
  );
}

const sha256 = text => createHash('sha256').update(text).digest('hex');

function format(path) {
  const formatted = spawnSync(oxfmt, ['--write', path], { encoding: 'utf8' });
  if (formatted.status !== 0)
    throw new Error(`oxfmt could not format ${path}.`);
}

// The hook keeps receipts outside every repository. Only receipts made in this
// clone, matched by the hash of its git common dir, are candidates.
function readCandidates(root) {
  const file = join(
    process.env.SKILL_RECEIPTS_DIR ?? join(homedir(), '.claude/skill-receipts'),
    'receipts.jsonl',
  );
  if (!existsSync(file)) return { file, candidates: [] };
  const commonDir = git(root, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  return {
    file,
    candidates: parseReceipts(readFileSync(file, 'utf8'), sha256(commonDir)),
  };
}

function record(root, args) {
  const review = args.includes('--review');
  const [id, base, head = 'HEAD'] = args.filter(arg => arg !== '--review');
  const routing = readRouting(root);
  const read = workingReader(root);
  const { lock, problems } = readLock(read, routing);
  const key = readPublicKey(read);
  const { file, candidates } = readCandidates(root);
  // The hook hashes the folder that Claude Code reports, and Claude Code
  // resolves it as pwd -P does. git resolves the top level too, so a worktree
  // reached through a link such as /tmp hashes the same on both sides.
  const { path, missing } = writeRecord(root, readRange(root, base, head), id, {
    review,
    folder: sha256(root),
    candidates,
    key,
    lock,
    routing,
  });
  format(path);
  const lines = [
    `Wrote ${relative(root, path)}. Add each skill's findings, the heading or rule each cites, and their resolutions.`,
  ];
  if (!lock) lines.push(...problems, 'Receipts were not pulled.');
  if (lock && !key)
    lines.push(
      'No public key is committed, so receipt signatures were not checked.',
    );
  const unreceipted = missing.map(({ skill, nested }) =>
    nested ? `${skill}/${nested}` : skill,
  );
  if (missing.length)
    lines.push(
      `${file} has no receipt from this change for ${unreceipted.join(', ')}. Make each one, then run this again:`,
      ...missing.map(
        ({ skill, nested }) =>
          `  ${receiptStep(routing, skill, process.env, root, nested)}`,
      ),
    );
  console.log(lines.join('\n'));
}

function catalog(root, lock) {
  const routing = readRouting(root);
  if (!lock) {
    for (const skill of Object.keys(routing.skills).sort())
      console.log(
        `${skill} ${resolveSkill(routing, skill, process.env, root)}`,
      );
    return;
  }
  const path = join(root, lockPath);
  writeFileSync(
    path,
    `${JSON.stringify(buildLock(routing, process.env, root), null, 2)}\n`,
  );
  format(path);
  console.log(`Wrote ${lockPath}. Review a change to it like a check change.`);
}

function check(root, [base, head = 'HEAD']) {
  const change = readRange(root, base, head);
  const pullRequest = process.env.GITHUB_EVENT_NAME === 'pull_request';
  const routing = readRouting(root);
  const { commits, problems, records, required } = checkRecords(
    root,
    routing,
    change,
    {
      pullRequest,
      step: (skill, nested) =>
        receiptStep(routing, skill, process.env, root, nested),
    },
  );
  const range = `${change.base.slice(0, 12)}..${change.head.slice(0, 12)} (${commits} ${commits === 1 ? 'commit' : 'commits'})`;
  if (problems.length) {
    console.error([`Skill records for ${range} fail:`, ...problems].join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(
    `Skill records for ${range} cover all ${required} required skills${pullRequest ? ' with independent review' : ''} (${records.join(', ') || 'no records needed'}).`,
  );
}

function doctor(root) {
  const { problems, notes, skills, copies, head } = checkSkillCopies(
    root,
    process.env,
  );
  for (const note of notes) console.log(`note ${note}`);
  if (problems.length) {
    console.error(
      [
        ...problems.map(problem => `FAIL ${problem}`),
        `skills doctor: ${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}. Fix or remove the copies above.`,
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }
  const except = notes.length
    ? ` except ${notes.length} allowed ${notes.length === 1 ? 'shadow' : 'shadows'}`
    : '';
  console.log(
    `skills doctor: ${skills} catalogued skills, ${copies} copies on disk, all match the lock at ${head.slice(0, 12)}${except}.`,
  );
}

const commandsWithoutArguments = { doctor, ledger: checkLedger };

function main(args) {
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  const [command, ...rest] = args;
  if (command === 'required' && rest[0] === '--plan' && rest.length > 1) {
    printRequired(root, readRouting(root), readPlan(rest.slice(1)));
  } else if (command === 'required' && rest.length && rest.length <= 2) {
    const change = readRange(root, rest[0], rest[1] ?? 'HEAD');
    printRequired(root, readRouting(root), change);
  } else if (
    command === 'catalog' &&
    (!rest.length || (rest.length === 1 && rest[0] === '--lock'))
  ) {
    catalog(root, rest.length === 1);
  } else if (
    command === 'record' &&
    [2, 3].includes(rest.filter(arg => arg !== '--review').length)
  ) {
    record(root, rest);
  } else if (command === 'check' && rest.length && rest.length <= 2) {
    check(root, rest);
  } else if (!rest.length && Object.hasOwn(commandsWithoutArguments, command)) {
    commandsWithoutArguments[command](root);
  } else {
    throw new Error(usage);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
