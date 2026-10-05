const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { delimiter, dirname, join, resolve } = require('node:path');
const { git } = require('../verification/snapshot.cjs');

const cli = resolve(__dirname, '../skills/cli.cjs');
const sha256 = text => createHash('sha256').update(text).digest('hex');
const skillText = (name, extra = '') =>
  `---\nname: ${name}\n---\n\n# ${name}\n\n1. Look.\n${extra}`;
const routing = {
  roots: {
    plug: { env: 'DOCTOR_ROOT_PLUG' },
    repo: { env: 'DOCTOR_ROOT_REPO', default: '.agents/skills' },
    user: { env: 'DOCTOR_ROOT_USER' },
  },
  skills: { alpha: 'plug', beta: 'user', gamma: 'repo' },
  skillFiles: { alpha: ['STANDARDS.md'] },
  rules: [
    { id: 'every-change', scope: 'change', why: 'Always.', skills: ['alpha'] },
  ],
};

let scratch;
let repository;
let head;
let env;

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const copy = (root, skill, path = 'SKILL.md') =>
  root === 'repo'
    ? join(repository, '.agents/skills', skill, path)
    : join(scratch, root, skill, path);
const standards = '# Standards\n\n1. Name it.\n';

function doctor(...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repository,
    encoding: 'utf8',
    env,
  });
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'skills-doctor-')));
  repository = join(scratch, 'repository');
  env = {
    ...process.env,
    DOCTOR_ROOT_PLUG: join(scratch, 'plug'),
    DOCTOR_ROOT_USER: join(scratch, 'user'),
  };
  mkdirSync(repository);
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'core.hooksPath', '/dev/null']);
  git(repository, ['config', 'user.name', 'Doctor fixture']);
  git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  write(join(repository, 'tools/skills/routing.json'), JSON.stringify(routing));
  write(copy('plug', 'alpha'), skillText('alpha'));
  write(copy('user', 'alpha'), skillText('alpha'));
  write(copy('plug', 'alpha', 'STANDARDS.md'), standards);
  write(copy('user', 'alpha', 'STANDARDS.md'), standards);
  write(copy('user', 'beta'), skillText('beta'));
  write(copy('repo', 'gamma'), skillText('gamma'));
  const locked = doctor('catalog', '--lock');
  if (locked.status !== 0) throw new Error(locked.stderr);
  git(repository, ['add', '--all']);
  git(repository, ['commit', '--quiet', '-m', 'Base']);
  head = git(repository, ['rev-parse', 'HEAD']);
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

test('passes when every copy of every catalogued skill matches the lock at HEAD', () => {
  expect(doctor('doctor')).toMatchObject({
    status: 0,
    stderr: '',
    stdout: `skills doctor: 3 catalogued skills, 4 copies on disk, all match the lock at ${head.slice(0, 12)}.\n`,
  });
});

test('fails on a changed, missing, or discoverable copy, and judges copies by the lock at HEAD', () => {
  const changed = skillText('alpha', '2. Changed.\n');
  write(copy('plug', 'alpha'), changed);
  write(copy('user', 'beta'), skillText('beta', '2. Changed.\n'));
  rmSync(dirname(copy('repo', 'gamma')), { recursive: true });
  const project = join(repository, '.claude/skills/gamma/SKILL.md');
  const synced = join(scratch, 'user/synced/team/alpha/SKILL.md');
  write(project, skillText('gamma'));
  write(synced, skillText('alpha'));
  const lockFile = join(repository, 'tools/skills/catalog.lock.json');
  const working = JSON.parse(readFileSync(lockFile, 'utf8'));
  working.skills.alpha.sha256 = sha256(changed);
  writeFileSync(lockFile, JSON.stringify(working));
  const locked = sha256(skillText('alpha')).slice(0, 8);
  expect(doctor('doctor')).toMatchObject({
    status: 1,
    stdout: '',
    stderr: [
      `FAIL alpha: the routed copy in plug hashes ${sha256(changed).slice(0, 8)}, but the lock pins ${locked} (${copy('plug', 'alpha')}).`,
      `FAIL alpha: Claude Code can also find a copy outside the routed roots (${synced}).`,
      `FAIL beta: the routed copy in user hashes ${sha256(skillText('beta', '2. Changed.\n')).slice(0, 8)}, but the lock pins ${sha256(skillText('beta')).slice(0, 8)} (${copy('user', 'beta')}).`,
      `FAIL gamma: its routed root repo has no copy (${copy('repo', 'gamma')}).`,
      `FAIL gamma: Claude Code can also find a copy outside the routed roots (${project}).`,
      'skills doctor: 5 problems. Fix or remove the copies above.',
      '',
    ].join('\n'),
  });
});

test('fails on a nested locked file that differs from the lock or is missing in any copy', () => {
  const edited = `${standards}2. Edited.\n`;
  write(copy('plug', 'alpha', 'STANDARDS.md'), edited);
  rmSync(copy('user', 'alpha', 'STANDARDS.md'));
  expect(doctor('doctor')).toMatchObject({
    status: 1,
    stdout: '',
    stderr: [
      `FAIL alpha: STANDARDS.md in the routed copy in plug hashes ${sha256(edited).slice(0, 8)}, but the lock pins ${sha256(standards).slice(0, 8)} (${copy('plug', 'alpha', 'STANDARDS.md')}).`,
      `FAIL alpha: the duplicate copy in user has no STANDARDS.md (${copy('user', 'alpha', 'STANDARDS.md')}).`,
      'skills doctor: 2 problems. Fix or remove the copies above.',
      '',
    ].join('\n'),
  });
});

test('fails on a copy in the .claude/skills folder of each folder that SKILL_DOCTOR_ADD_DIRS lists', () => {
  const added = [join(scratch, 'handoff'), join(scratch, 'planning')];
  const found = join(added[1], '.claude/skills/gamma/SKILL.md');
  write(found, skillText('gamma'));
  mkdirSync(added[0]);
  expect(doctor('doctor').status).toBe(0);
  env.SKILL_DOCTOR_ADD_DIRS = added.join(delimiter);
  expect(doctor('doctor')).toMatchObject({
    status: 1,
    stdout: '',
    stderr: [
      `FAIL gamma: Claude Code can also find a copy outside the routed roots (${found}).`,
      'skills doctor: 1 problem. Fix or remove the copies above.',
      '',
    ].join('\n'),
  });
});

test('allows a differing copy outside the routed root only as a listed shadow with that exact hash', () => {
  const { checkSkillCopies } = require('../skills/doctor.cjs');
  const shadow = skillText('beta', '2. Plugin edition.\n');
  write(copy('plug', 'beta'), shadow);
  const listed = { 'plug:beta': sha256(shadow) };
  expect(checkSkillCopies(repository, env, listed)).toEqual({
    problems: [],
    notes: [
      `beta: plug:beta differs from the lock (${sha256(shadow).slice(0, 8)}), and is an allowed shadow.`,
    ],
    skills: 3,
    copies: 5,
    head,
  });
  const unlisted = `FAIL beta: the duplicate copy in plug hashes ${sha256(shadow).slice(0, 8)}, but the lock pins ${sha256(skillText('beta')).slice(0, 8)} (${copy('plug', 'beta')}).`;
  expect(doctor('doctor').stderr.split('\n')[0]).toBe(unlisted);
  write(copy('plug', 'beta'), skillText('beta', '2. Edited again.\n'));
  expect(checkSkillCopies(repository, env, listed).problems).toHaveLength(1);
  write(copy('plug', 'beta'), skillText('beta'));
  write(copy('user', 'beta'), shadow);
  expect(
    checkSkillCopies(repository, env, { 'user:beta': sha256(shadow) }),
  ).toMatchObject({
    notes: [],
    problems: [expect.stringContaining('routed copy in user')],
  });
});
