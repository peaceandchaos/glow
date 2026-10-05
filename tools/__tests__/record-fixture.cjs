const { spawnSync } = require('node:child_process');
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { git } = require('../verification/snapshot.cjs');
const {
  installHook,
  makeKey,
  signReceipt,
  skillPayload,
} = require('./receipt-fixture.cjs');

const cli = resolve(__dirname, '../skills/cli.cjs');

const routing = {
  roots: { main: { env: 'SKILL_ROOT_MAIN' } },
  skills: { always: 'main', 'source-care': 'main', extra: 'main' },
  skillFiles: { 'source-care': ['STANDARDS.md'] },
  rules: [
    { id: 'every-change', scope: 'change', why: 'Always.', skills: ['always'] },
    {
      id: 'source',
      scope: 'file',
      why: 'Source.',
      paths: ['src/**'],
      skills: ['source-care'],
    },
  ],
};
const skillText = (name, front = '') =>
  `---\nname: ${name}\n${front}---\n\n# ${name}\n\n## Steps\n\n1. Look.\n2. Fix.\n`;
const unloadableSkill = 'extra';
const frontMatterOf = name =>
  name === unloadableSkill ? 'disable-model-invocation: true\n' : '';
const standardsText = '# Standards\n\n## Naming\n\n1. Name what it holds.\n';

let scratch;
let repository;
let reviewFolder;
let skillsRoot;
let hook;
let base;
let work;
let middle;
let later;
let receipt;

function write(path, text) {
  mkdirSync(dirname(join(repository, path)), { recursive: true });
  writeFileSync(join(repository, path), text);
}

function commit(message) {
  git(repository, ['add', '--all']);
  git(repository, ['commit', '--quiet', '-m', message]);
  return git(repository, ['rev-parse', 'HEAD']);
}

function writeRecords(records) {
  for (const record of records)
    write(
      `tools/skills/records/${record.change}.json`,
      JSON.stringify({ base: { commit: base }, ...record }),
    );
}

function recordOn(branch, records, remove = [], from = work) {
  git(repository, ['checkout', '--quiet', '-B', branch, from]);
  git(repository, ['clean', '--force', '-d', '--quiet']);
  for (const path of remove) rmSync(join(repository, path));
  writeRecords(records);
  return commit(`chore: record ${branch}`);
}

function skills(args, env = {}, cwd = repository) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      SKILL_ROOT_MAIN: skillsRoot,
      SKILL_RECEIPTS_DIR: join(scratch, 'no-receipts'),
      GITHUB_EVENT_NAME: undefined,
      ...env,
    },
  });
}

// Loads a skill by its qualified name, as an agent loads a plugin skill.
function sign(skill, options = {}) {
  const { cwd = repository, key = 'key', state = 'state', ...extra } = options;
  const loaded = skill && `main:${skill}`;
  return signReceipt(hook, skillPayload(loaded, cwd, extra), {
    SKILL_RECEIPTS_DIR: join(scratch, state),
    SKILL_RECEIPTS_KEY: join(scratch, `${key}.pem`),
  });
}

function readOf(path, input = {}) {
  const file = join(skillsRoot, path);
  return {
    tool_name: 'Read',
    tool_input: { file_path: file, ...input },
    tool_response: {
      type: 'text',
      file: { filePath: file, content: readFileSync(file, 'utf8') },
    },
  };
}

const signInReviewFolder = (skill, options = {}) =>
  sign(skill, { cwd: reviewFolder, ...options });

// Signs a receipt in the reviewer's worktree, a separate folder of the same
// clone, after moving that worktree to `commit`.
function signInReview(commit, skill, options = {}) {
  git(reviewFolder, ['checkout', '--quiet', '--force', '--detach', commit]);
  return signInReviewFolder(skill, options);
}

const range = (head, commits) =>
  `${base.slice(0, 12)}..${head.slice(0, 12)} (${commits} commits)`;

function patchOf(commit) {
  const shown = git(repository, ['show', commit]);
  return spawnSync('git', ['patch-id', '--stable'], {
    cwd: repository,
    input: `${shown}\n`,
    encoding: 'utf8',
  }).stdout.split(' ')[0];
}

const cite = (finding, commit) => ({
  finding,
  cites: 'Steps 1',
  commit: commit.slice(0, 12),
  patch: patchOf(commit),
});
const looked = (finding = 'Looked.', none = 'Fine.') => ({
  finding,
  cites: 'Steps',
  none,
});
const authored = (skill, files, ...receipts) => ({
  skill,
  files,
  findings: [looked()],
  receipts,
});
const reviewed = (skill, ...receipts) => ({
  skill,
  findings: [looked()],
  receipts,
});
function stepFor(skill, rootsSet = true) {
  if (!rootsSet || skill === 'ghost')
    return `follow the line that npm run skills:required prints for ${skill}`;
  const file = join(skillsRoot, skill, 'SKILL.md');
  return skill === unloadableSkill
    ? `read all of ${file}`
    : `load main:${skill} from ${file}`;
}
const readStep = (skill, path, rootsSet = true) =>
  rootsSet
    ? `read all of ${join(skillsRoot, skill, path)}`
    : `read all of ${path} in the ${skill} skill folder`;
const noAuthorReceipt = (change, skill, step = stepFor(skill)) =>
  `tools/skills/records/${change}.json: ${skill} has no valid author receipt. To make one, ${step}, then run npm run skills:record -- ${change} <base>.`;

function setUpRecordFixture() {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'records-fixture-')));
  repository = join(scratch, 'repository');
  reviewFolder = join(scratch, 'review');
  skillsRoot = join(scratch, 'skills');
  for (const name of ['always', 'source-care', 'extra', 'ghost']) {
    mkdirSync(join(skillsRoot, name), { recursive: true });
    writeFileSync(
      join(skillsRoot, name, 'SKILL.md'),
      skillText(name, frontMatterOf(name)),
    );
  }
  writeFileSync(join(skillsRoot, 'source-care/STANDARDS.md'), standardsText);
  hook = installHook(join(scratch, 'hooks'), {
    plugins: { main: skillsRoot },
    user: null,
    repo: [],
  });
  const publicKey = makeKey(join(scratch, 'key.pem'));
  makeKey(join(scratch, 'other-key.pem'));
  mkdirSync(repository);
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'core.hooksPath', '/dev/null']);
  // Background maintenance can pack loose objects mid-run, and one test
  // deletes a loose object.
  git(repository, ['config', 'maintenance.auto', 'false']);
  git(repository, ['config', 'user.name', 'Records fixture']);
  git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  write('tools/skills/routing.json', JSON.stringify(routing));
  write('tools/skills/receipt-public-key.pem', publicKey);
  write('README.md', '# Fixture\n');
  const locked = skills(['catalog', '--lock']);
  if (locked.status !== 0) throw new Error(locked.stderr);
  write(
    'tools/skills/records/merged.json',
    JSON.stringify({
      change: 'merged',
      skills: ['always', 'source-care'].map(skill => ({
        skill,
        files: ['**', '<change>'],
        findings: [looked()],
        receipts: [],
      })),
    }),
  );
  base = commit('Base');
  receipt = { atBase: sign('always') };
  write('src/a.ts', 'export const a = 1;\n');
  work = commit('feat: add a');
  receipt.always = sign('always');
  receipt.source = sign('source-care');
  git(repository, [
    'worktree',
    'add',
    '--quiet',
    '--detach',
    reviewFolder,
    work,
  ]);
  receipt.reviewAlways = signInReview(work, 'always', {
    session_id: 'session-review',
  });
  receipt.reviewSource = signInReview(work, 'source-care', {
    session_id: 'session-review',
  });
  receipt.subagentAlways = signInReview(work, 'always', {
    agent_id: 'agent-review',
  });
  receipt.subagentSource = signInReview(work, 'source-care', {
    agent_id: 'agent-review',
  });
  git(repository, ['checkout', '--quiet', '-B', 'stack', work]);
  writeRecords([
    {
      change: 'lower',
      skills: [
        authored('always', ['<change>'], receipt.always),
        authored('source-care', ['src/**'], receipt.source),
      ],
      review: {
        skills: [
          reviewed('always', receipt.reviewAlways),
          reviewed('source-care', receipt.reviewSource),
        ],
      },
    },
  ]);
  middle = commit('chore: record lower');
  write('src/b.ts', 'export const b = 2;\n');
  later = commit('feat: add b');
  receipt.upperAlways = sign('always');
  receipt.upperSource = sign('source-care');
  receipt.upperExtra = sign('extra');
  receipt.upperReviewAlways = signInReview(later, 'always', {
    session_id: 'session-review',
  });
  receipt.upperReviewSource = signInReview(later, 'source-care', {
    session_id: 'session-review',
  });
  return {
    scratch,
    repository,
    reviewFolder,
    skillsRoot,
    hook,
    base,
    work,
    middle,
    later,
    receipt,
  };
}

function removeRecordFixture() {
  rmSync(scratch, { recursive: true, force: true });
}

module.exports = {
  cli,
  skillText,
  standardsText,
  write,
  commit,
  writeRecords,
  recordOn,
  skills,
  sign,
  readOf,
  signInReviewFolder,
  signInReview,
  range,
  patchOf,
  cite,
  looked,
  authored,
  reviewed,
  stepFor,
  readStep,
  noAuthorReceipt,
  setUpRecordFixture,
  removeRecordFixture,
};
