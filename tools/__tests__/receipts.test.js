const { spawnSync } = require('node:child_process');
const { createHash, createPublicKey, verify } = require('node:crypto');
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { git } = require('../verification/snapshot.cjs');
const { canonical, parseReceipts } = require('../skills/receipts.cjs');
const {
  installHook,
  makeKey,
  receiptsIn,
  resign,
  runHook,
  signReceipt,
  skillPayload,
} = require('./receipt-fixture.cjs');

const installer = resolve(__dirname, '../skills/install-receipt-hook.mjs');
const sha256 = text => createHash('sha256').update(text).digest('hex');

let scratch;
let repository;
let hook;
let publicKey;
let env;
const text = {
  user: '# User skill\n\n## Steps\n\n1. Look.\n',
  plugin: '# Plugin skill\n\n1. Read.\n',
  repo: '# Repo skill\n',
  standards: '# Standards\n\n## Easing\n\n1. Ease out.\n',
  reference: '# Animations\n',
  guide: '# Guide\n',
};

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const userFile = () => join(scratch, 'user/lookup/SKILL.md');
const readPayload = (file, input = {}, content = readFileSync(file, 'utf8')) =>
  skillPayload(null, repository, {
    tool_name: 'Read',
    tool_input: { file_path: file, ...input },
    tool_response: { type: 'text', file: { filePath: file, content } },
  });

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'receipt-hook-')));
  repository = join(scratch, 'repository');
  mkdirSync(repository);
  git(repository, ['init', '--quiet', '--initial-branch', 'feature']);
  git(repository, ['config', 'core.hooksPath', '/dev/null']);
  git(repository, ['config', 'user.name', 'Hook fixture']);
  git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  write(join(repository, '.agents/skills/local/SKILL.md'), text.repo);
  git(repository, ['add', '--all']);
  git(repository, ['commit', '--quiet', '-m', 'Base']);
  write(userFile(), text.user);
  write(join(scratch, 'plugin/reader/SKILL.md'), text.plugin);
  hook = installHook(join(scratch, 'hooks'), {
    plugins: { plug: join(scratch, 'plugin') },
    user: join(scratch, 'user'),
    repo: ['.agents/skills'],
  });
  publicKey = createPublicKey(makeKey(join(scratch, 'key.pem')));
  env = {
    SKILL_RECEIPTS_DIR: join(scratch, 'state'),
    SKILL_RECEIPTS_KEY: join(scratch, 'key.pem'),
  };
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function verified(receipt) {
  const { sig, ...fields } = receipt;
  return verify(
    null,
    Buffer.from(canonical(fields)),
    publicKey,
    Buffer.from(sig, 'base64'),
  );
}

test('signs a Claude Code Skill load with the skill text hash and the repository state', () => {
  const receipt = signReceipt(
    hook,
    skillPayload('plug:reader', repository),
    env,
  );
  const head = git(repository, ['rev-parse', 'HEAD']);
  const patch = spawnSync('git', ['patch-id', '--stable'], {
    input: `${git(repository, ['show', 'HEAD'])}\n`,
    encoding: 'utf8',
  }).stdout.split(' ')[0];
  const { sig, time, toolUseId, ...rest } = receipt;
  expect(rest).toEqual({
    v: 2,
    client: 'claude-code',
    skill: 'reader',
    skillRef: 'plug:reader',
    source: 'Skill',
    sha256: sha256(text.plugin),
    partial: false,
    session: 'session-author',
    agent: null,
    agentType: null,
    cwd: sha256(repository),
    commonDir: sha256(join(repository, '.git')),
    branch: 'feature',
    head,
    headPatch: patch,
  });
  expect(toolUseId).toMatch(/^toolu-/u);
  expect(Date.parse(time)).not.toBeNaN();
  expect(verified(receipt)).toBe(true);
  expect(verified({ ...receipt, sha256: sha256('edited') })).toBe(false);
});

test('resolves bare names through the user root, then the repository skills, then the plugins, and names the root that held the file', () => {
  write(join(scratch, 'plugin/lookup/SKILL.md'), text.plugin);
  expect(
    signReceipt(hook, skillPayload('lookup', repository), env),
  ).toMatchObject({
    skill: 'lookup',
    skillRef: 'lookup',
    sha256: sha256(text.user),
  });
  expect(
    signReceipt(hook, skillPayload('plug:lookup', repository), env),
  ).toMatchObject({
    skill: 'lookup',
    skillRef: 'plug:lookup',
    sha256: sha256(text.plugin),
  });
  expect(
    signReceipt(hook, skillPayload('local', repository), env),
  ).toMatchObject({
    skill: 'local',
    skillRef: 'local',
    sha256: sha256(text.repo),
  });
  expect(
    signReceipt(hook, skillPayload('reader', repository), env),
  ).toMatchObject({
    skill: 'reader',
    skillRef: 'plug:reader',
    sha256: sha256(text.plugin),
  });
});

test('names the root that holds a fully read SKILL.md, and gives a copy outside every root its bare name', () => {
  const read = file =>
    skillPayload(null, repository, {
      tool_name: 'Read',
      tool_input: { file_path: file },
      tool_response: {
        type: 'text',
        file: { filePath: file, content: readFileSync(file, 'utf8') },
      },
    });
  const outside = join(scratch, 'copies/reader/SKILL.md');
  write(outside, text.plugin);
  expect(
    [
      join(scratch, 'plugin/reader/SKILL.md'),
      userFile(),
      join(repository, '.agents/skills/local/SKILL.md'),
      outside,
    ].map(file => signReceipt(hook, read(file), env).skillRef),
  ).toEqual(['plug:reader', 'lookup', 'local', 'reader']);
});

test('marks a Read of a SKILL.md partial unless it returned the whole file without offset or limit', () => {
  const read = (input, content) =>
    skillPayload(null, repository, {
      tool_name: 'Read',
      tool_input: { file_path: userFile(), ...input },
      tool_response: {
        type: 'text',
        file: { filePath: userFile(), content },
      },
    });
  expect(signReceipt(hook, read({}, text.user), env)).toMatchObject({
    skill: 'lookup',
    skillRef: 'lookup',
    source: 'Read',
    sha256: sha256(text.user),
    partial: false,
  });
  expect(signReceipt(hook, read({ limit: 3 }, text.user), env).partial).toBe(
    true,
  );
  expect(signReceipt(hook, read({ offset: 1 }, text.user), env).partial).toBe(
    true,
  );
  expect(signReceipt(hook, read({}, text.user.slice(0, 10)), env).partial).toBe(
    true,
  );
});

test('signs a full Read of any file in a skill folder for the first folder under the root, with the path inside it as file', () => {
  const files = {
    standards: join(scratch, 'plugin/reader/STANDARDS.md'),
    reference: join(scratch, 'plugin/reader/references/animations/SKILL.md'),
    guide: join(repository, '.agents/skills/local/notes/GUIDE.md'),
  };
  for (const [name, file] of Object.entries(files)) write(file, text[name]);
  const [standards, reference, guide] = Object.values(files).map(file =>
    signReceipt(hook, readPayload(file), env),
  );
  expect(standards).toMatchObject({
    v: 2,
    skill: 'reader',
    skillRef: 'plug:reader',
    file: 'STANDARDS.md',
    source: 'Read',
    sha256: sha256(text.standards),
    partial: false,
  });
  expect(reference).toMatchObject({
    skill: 'reader',
    skillRef: 'plug:reader',
    file: 'references/animations/SKILL.md',
    sha256: sha256(text.reference),
    partial: false,
  });
  expect(guide).toMatchObject({
    skill: 'local',
    skillRef: 'local',
    file: 'notes/GUIDE.md',
    sha256: sha256(text.guide),
    partial: false,
  });
  expect(verified(standards)).toBe(true);
  expect(verified({ ...standards, file: 'OTHER.md' })).toBe(false);
  const skillRead = signReceipt(
    hook,
    readPayload(join(scratch, 'plugin/reader/SKILL.md')),
    env,
  );
  expect(skillRead).toMatchObject({ skill: 'reader', partial: false });
  expect(skillRead).not.toHaveProperty('file');
  expect(
    signReceipt(hook, skillPayload('plug:reader', repository), env),
  ).not.toHaveProperty('file');
});

test('marks a Read of a nested skill file partial unless it returned the whole file without offset or limit', () => {
  const file = join(scratch, 'plugin/reader/STANDARDS.md');
  write(file, text.standards);
  expect(
    [
      readPayload(file, { limit: 2 }),
      readPayload(file, { offset: 1 }),
      readPayload(file, {}, text.standards.slice(0, 5)),
    ].map(payload => signReceipt(hook, payload, env)),
  ).toEqual([
    expect.objectContaining({ file: 'STANDARDS.md', partial: true }),
    expect.objectContaining({ file: 'STANDARDS.md', partial: true }),
    expect.objectContaining({ file: 'STANDARDS.md', partial: true }),
  ]);
});

test('runs no git for a Read outside every skill folder', () => {
  const realGit = spawnSync('sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
  }).stdout.trim();
  const bin = join(scratch, 'counting-bin');
  const calls = join(scratch, 'git-calls.log');
  write(
    join(bin, 'git'),
    `#!/bin/sh\necho "$1" >> '${calls}'\nexec '${realGit}' "$@"\n`,
  );
  chmodSync(join(bin, 'git'), 0o755);
  const counted = { ...env, PATH: `${bin}:${process.env.PATH}` };
  const plain = join(scratch, 'notes/plain.md');
  write(plain, '# Notes\n');
  const result = runHook(hook, readPayload(plain), counted);
  expect([result.status, existsSync(calls)]).toEqual([0, false]);
  signReceipt(hook, readPayload(userFile()), counted);
  expect(readFileSync(calls, 'utf8')).toContain('rev-parse');
});

test('records the subagent that loaded a skill', () => {
  expect(
    signReceipt(
      hook,
      skillPayload('lookup', repository, {
        agent_id: 'agent-7',
        agent_type: 'pstack:poteto-agent',
      }),
      env,
    ),
  ).toMatchObject({ agent: 'agent-7', agentType: 'pstack:poteto-agent' });
});

test('reads the Cursor payload shape', () => {
  const receipt = signReceipt(
    hook,
    {
      cursor_version: '2.1.0',
      conversation_id: 'conversation-1',
      generation_id: 'generation-1',
      workspace_roots: [repository],
      hook_event_name: 'postToolUse',
      tool_name: 'Read',
      tool_input: JSON.stringify({ file_path: userFile() }),
      tool_output: JSON.stringify({ content: text.user }),
    },
    env,
  );
  expect(receipt).toMatchObject({
    client: 'cursor',
    session: 'conversation-1',
    toolUseId: 'generation-1',
    cwd: sha256(repository),
    source: 'Read',
    partial: true,
  });
  expect(
    signReceipt(
      hook,
      {
        cursor_version: '2.1.0',
        conversation_id: 'conversation-1',
        generation_id: 'generation-2',
        workspace_roots: [repository],
        tool_name: 'Read',
        tool_input: { file_path: userFile() },
        tool_output: text.user,
      },
      env,
    ),
  ).toMatchObject({ client: 'cursor', partial: false });
  expect(verified(receipt)).toBe(true);
});

test('stays silent and exits 0 for other tools, unknown skills, and bad input, and logs the errors', () => {
  const state = join(scratch, 'quiet');
  const quiet = { ...env, SKILL_RECEIPTS_DIR: state };
  const inRoot = join(scratch, 'plugin/README.md');
  const outside = join(scratch, 'copies/reader/STANDARDS.md');
  write(inRoot, '# Plugin\n');
  write(outside, text.standards);
  for (const payload of [
    skillPayload(null, repository, {
      tool_name: 'Read',
      tool_input: { file_path: join(repository, 'README.md') },
    }),
    readPayload(inRoot),
    readPayload(outside),
    readPayload(join(scratch, 'plugin/reader/MISSING.md'), {}, ''),
    skillPayload(null, repository, { tool_name: 'Bash', tool_input: {} }),
    skillPayload('plug:missing', repository),
    'not json',
  ]) {
    const result = runHook(hook, payload, quiet);
    expect([result.status, result.stdout, result.stderr]).toEqual([0, '', '']);
  }
  expect(receiptsIn(state)).toEqual([]);
  const errors = readFileSync(join(state, 'errors.log'), 'utf8');
  expect(errors).toContain('No SKILL.md for plug:missing.');
  expect(errors).toContain('JSON');
  expect(
    errors
      .trim()
      .split('\n')
      .filter(line => /^\d{4}-/u.test(line)),
  ).toHaveLength(2);
});

test('parses v: 1 receipts without a skill reference and v: 2 receipts with one and an optional file, and drops the rest', () => {
  const current = signReceipt(
    hook,
    skillPayload('plug:reader', repository),
    env,
  );
  const key = join(scratch, 'key.pem');
  const older = resign(current, { v: 1, skillRef: undefined }, key);
  const nested = resign(
    current,
    { file: 'references/animations/SKILL.md' },
    key,
  );
  const lines = [
    older,
    current,
    nested,
    resign(current, { skillRef: undefined }, key),
    resign(current, { v: 1 }, key),
    resign(current, { v: 3 }, key),
    resign(older, { file: 'STANDARDS.md' }, key),
    resign(current, { file: '' }, key),
    resign(current, { file: '../reader/STANDARDS.md' }, key),
    resign(current, { file: '/STANDARDS.md' }, key),
  ];
  expect(
    parseReceipts(
      lines.map(line => JSON.stringify(line)).join('\n'),
      current.commonDir,
    ),
  ).toEqual([older, current, nested]);
});

describe('installer', () => {
  let home;
  const installEnv = () => ({
    ...process.env,
    HOME: home,
    SKILL_ROOT_PSTACK: join(scratch, 'plugin'),
    SKILL_ROOT_GLOW_GUIDES: join(scratch, 'plugin'),
    SKILL_ROOT_USER: join(scratch, 'user'),
  });
  const install = (...args) =>
    spawnSync(process.execPath, [installer, ...args], {
      encoding: 'utf8',
      env: installEnv(),
    });
  const listing = () =>
    readdirSync(home, { recursive: true }).map(String).sort();
  const spike = {
    matcher: 'Skill|Read',
    hooks: [
      { type: 'command', command: 'node "$HOME/.claude/hooks/spike.mjs"' },
    ],
  };

  beforeAll(() => {
    home = join(scratch, 'home');
    write(
      join(home, '.claude/settings.json'),
      `${JSON.stringify({ permissions: { deny: ['Read(/settings.json)'] }, hooks: { PostToolUse: [spike] } }, null, 2)}\n`,
    );
  });

  test('changes nothing without --apply, and prints the plan with each settings change', () => {
    const before = listing();
    const settings = readFileSync(join(home, '.claude/settings.json'), 'utf8');
    const result = install();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(listing()).toEqual(before);
    expect(readFileSync(join(home, '.claude/settings.json'), 'utf8')).toBe(
      settings,
    );
    expect(result.stdout).toContain(
      `- Create ${join(home, '.claude/hooks/skill-receipt-hook.mjs')}.`,
    );
    expect(result.stdout).toContain('Generate an Ed25519 keypair.');
    const entry = {
      matcher: 'Skill|Read',
      hooks: [
        {
          type: 'command',
          command: `"${process.execPath}" "${join(home, '.claude/hooks/skill-receipt-hook.mjs')}"`,
          timeout: 5,
        },
      ],
    };
    expect(result.stdout).toContain(
      [
        `- Update ${join(home, '.claude/settings.json')}:`,
        `  + hooks.PostToolUse ${JSON.stringify(entry)}`,
        ...[
          'Read(/hooks/**)',
          'Edit(/hooks/**)',
          'Read(/skill-receipts/private-key.pem)',
          'Edit(/skill-receipts/**)',
          'Bash(*.claude/hooks*)',
          'Bash(*skill-receipt-hook*)',
          'Bash(*skill-receipts*)',
          'Bash(*private-key.pem*)',
        ].map(rule => `  + permissions.deny ${JSON.stringify(rule)}`),
        'Note:',
      ].join('\n'),
    );
    expect(result.stdout).toContain(
      'Note: Leave 1 other Skill|Read PostToolUse entry in place. Pass --remove-spike to remove it.',
    );
    expect(result.stdout.trimEnd().split('\n').at(-1)).toBe(
      'Dry run. Nothing was written. Run again with --apply.',
    );
  });

  test('applies once, keeps the key on a second run, and the installed hook signs receipts', () => {
    const original = readFileSync(join(home, '.claude/settings.json'), 'utf8');
    const first = install('--apply');
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    const key = join(home, '.claude/skill-receipts/private-key.pem');
    expect(statSync(key).mode & 0o777).toBe(0o600);
    const keyText = readFileSync(key, 'utf8');
    const printed = first.stdout.slice(first.stdout.indexOf('-----BEGIN'));
    expect(
      createPublicKey(keyText).export({ type: 'spki', format: 'pem' }),
    ).toBe(`${printed.trimEnd()}\n`);
    expect(
      readFileSync(join(home, '.claude/hooks/skill-receipt-hook.mjs'), 'utf8'),
    ).toBe(
      readFileSync(resolve(__dirname, '../skills/receipt-hook.mjs'), 'utf8'),
    );
    const backups = readdirSync(join(home, '.claude')).filter(name =>
      name.startsWith('settings.json.backup-'),
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(home, '.claude', backups[0]), 'utf8')).toBe(
      original,
    );
    const settings = JSON.parse(
      readFileSync(join(home, '.claude/settings.json'), 'utf8'),
    );
    expect(settings.hooks.PostToolUse).toEqual([
      spike,
      {
        matcher: 'Skill|Read',
        hooks: [
          {
            type: 'command',
            command: `"${process.execPath}" "${join(home, '.claude/hooks/skill-receipt-hook.mjs')}"`,
            timeout: 5,
          },
        ],
      },
    ]);
    expect(settings.permissions.deny).toEqual([
      'Read(/settings.json)',
      'Read(/hooks/**)',
      'Edit(/hooks/**)',
      'Read(/skill-receipts/private-key.pem)',
      'Edit(/skill-receipts/**)',
      'Bash(*.claude/hooks*)',
      'Bash(*skill-receipt-hook*)',
      'Bash(*skill-receipts*)',
      'Bash(*private-key.pem*)',
    ]);

    const second = install('--apply');
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('- None.');
    expect(second.stdout).toContain(printed.trimEnd());
    expect(readFileSync(key, 'utf8')).toBe(keyText);
    expect(
      readdirSync(join(home, '.claude')).filter(name =>
        name.startsWith('settings.json.backup-'),
      ),
    ).toHaveLength(1);

    const result = spawnSync(
      process.execPath,
      [join(home, '.claude/hooks/skill-receipt-hook.mjs')],
      {
        input: JSON.stringify(skillPayload('pstack:reader', repository)),
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: home },
      },
    );
    expect([result.status, result.stdout, result.stderr]).toEqual([0, '', '']);
    const [receipt] = receiptsIn(join(home, '.claude/skill-receipts'));
    expect(receipt).toMatchObject({
      skill: 'reader',
      skillRef: 'pstack:reader',
      sha256: sha256(text.plugin),
    });
    const { sig, ...fields } = receipt;
    expect(
      verify(
        null,
        Buffer.from(canonical(fields)),
        createPublicKey(keyText),
        Buffer.from(sig, 'base64'),
      ),
    ).toBe(true);
  }, 20000);

  test('removes the spike entry only with --remove-spike', () => {
    const result = install('--apply', '--remove-spike');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `:\n  - hooks.PostToolUse ${JSON.stringify(spike)}\n`,
    );
    const settings = JSON.parse(
      readFileSync(join(home, '.claude/settings.json'), 'utf8'),
    );
    expect(
      settings.hooks.PostToolUse.map(entry => entry.hooks[0].command),
    ).toEqual([
      `"${process.execPath}" "${join(home, '.claude/hooks/skill-receipt-hook.mjs')}"`,
    ]);
    expect(install('--apply', '--remove-spike').stdout).toContain('- None.');
  });
});
