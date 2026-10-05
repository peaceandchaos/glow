const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { git } = require('../verification/snapshot.cjs');
const { parseRouting, requiredSkills } = require('../skills/routing.cjs');

const cli = resolve(__dirname, '../skills/cli.cjs');

const fixtureRouting = {
  roots: {
    main: { env: 'SKILL_ROOT_MAIN' },
    local: { env: 'SKILL_ROOT_LOCAL', default: 'skills' },
  },
  skills: {
    'api-care': 'main',
    'big-review': 'main',
    'doc-style': 'local',
    'every-time': 'main',
    'feature-review': 'main',
    'export-care': 'main',
    'fix-care': 'main',
    'move-care': 'main',
    'network-care': 'main',
    'new-file-care': 'main',
    'tiny-care': 'main',
  },
  skillFiles: {
    'big-review': ['references/alpha/SKILL.md', 'STANDARDS.md'],
  },
  rules: [
    {
      id: 'every-change',
      scope: 'change',
      why: 'Always.',
      skills: ['every-time'],
    },
    {
      id: 'large-change',
      scope: 'change',
      why: 'Big.',
      minChangedLines: 4,
      excludePaths: ['generated/**'],
      skills: ['big-review'],
    },
    {
      id: 'fix-commits',
      scope: 'change',
      why: 'Fixes.',
      commitSubject: '^fix:',
      skills: ['fix-care'],
    },
    {
      id: 'big-feature',
      scope: 'change',
      why: 'Big features.',
      minChangedLines: 1,
      commitSubject: '^feat:',
      skills: ['feature-review'],
    },
    {
      id: 'source',
      scope: 'file',
      why: 'Source.',
      paths: ['src/**'],
      skills: ['api-care'],
    },
    {
      id: 'docs',
      scope: 'file',
      why: 'Docs.',
      paths: ['**/*.md'],
      skills: ['doc-style'],
    },
    {
      id: 'removed-exports',
      scope: 'file',
      why: 'Exports.',
      removedExports: true,
      skills: ['api-care', 'export-care'],
    },
    {
      id: 'moves',
      scope: 'file',
      why: 'Moves.',
      status: ['deleted', 'renamed'],
      skills: ['move-care'],
    },
    {
      id: 'added',
      scope: 'file',
      why: 'New.',
      status: ['added'],
      excludePaths: ['generated/**'],
      skills: ['new-file-care'],
    },
    {
      id: 'network',
      scope: 'file',
      why: 'Network.',
      addedLines: '\\bfetch\\(',
      skills: ['network-care'],
    },
  ],
};

const fixtureLedger = {
  lessons: [
    {
      id: 'client-retry',
      lesson: 'Retry a failed load once.',
      seen: ['an earlier fix'],
      enforcement: { kind: 'guidance' },
      paths: ['src/client.ts'],
    },
    {
      id: 'head-watch',
      lesson: 'Watch the pushed head.',
      seen: ['one run', 'another run'],
      enforcement: { kind: 'guidance' },
      link: 'https://example.invalid/decision',
    },
    {
      id: 'lib-care',
      lesson: 'Library code needs care.',
      seen: ['a library change'],
      enforcement: { kind: 'guidance' },
      paths: ['lib/**'],
    },
    {
      id: 'typed',
      lesson: 'A type enforces this.',
      seen: ['a type fix'],
      enforcement: { kind: 'check', check: 'types' },
      paths: ['src/**'],
    },
  ],
};

const nestedFiles = {
  'STANDARDS.md': [
    '# Standards',
    '## Easing',
    '1. Ease out.',
    '```css',
    '## not a heading',
    '```',
    '',
  ].join('\n'),
  'references/alpha/SKILL.md': [
    '---',
    'name: alpha',
    '---',
    '# Alpha',
    '## Critical Rules',
    '',
  ].join('\n'),
};

const sha256 = text => createHash('sha256').update(text).digest('hex');

function write(directory, path, text) {
  mkdirSync(dirname(join(directory, path)), { recursive: true });
  writeFileSync(join(directory, path), text);
}

function commit(directory, message) {
  git(directory, ['add', '--all']);
  git(directory, ['commit', '--quiet', '-m', message]);
  return git(directory, ['rev-parse', 'HEAD']);
}

let fixture;
let base;
let head;
let env;

beforeAll(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'skills-fixture-')));
  const repository = join(fixture, 'repository');
  const roots = join(fixture, 'roots');
  mkdirSync(repository);
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'core.hooksPath', '/dev/null']);
  git(repository, ['config', 'user.name', 'Skills fixture']);
  git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  for (const [skill, root] of Object.entries(fixtureRouting.skills)) {
    const directory = root === 'main' ? roots : join(repository, 'skills');
    const flag =
      skill === 'move-care' ? 'disable-model-invocation: true\n' : '';
    write(directory, `${skill}/SKILL.md`, `---\nname: ${skill}\n${flag}---\n`);
  }
  for (const [path, text] of Object.entries(nestedFiles))
    write(roots, `big-review/${path}`, text);
  write(roots, 'big-review/references/alpha/notes.md', '# Notes\n');
  write(
    repository,
    'tools/skills/routing.json',
    JSON.stringify(fixtureRouting),
  );
  write(repository, 'tools/skills/ledger.json', JSON.stringify(fixtureLedger));
  write(
    repository,
    'src/api.ts',
    'export function keep() {}\nexport const dropped = 1;\nexport type Gone = string;\n',
  );
  write(repository, 'src/legacy.cjs', 'module.exports = { old: 1 };\n');
  write(repository, 'docs/guide.md', '# Guide\n\nRead this.\n');
  base = commit(repository, 'Base');
  write(repository, 'src/api.ts', 'export function keep() {}\n');
  unlinkSync(join(repository, 'src/legacy.cjs'));
  renameSync(
    join(repository, 'docs/guide.md'),
    join(repository, 'docs/manual.md'),
  );
  write(repository, 'generated/data.txt', 'a\nb\nc\nd\ne\nf\ng\n');
  commit(repository, 'refactor: trim the API');
  write(repository, 'src/client.ts', "export const load = () => fetch('/');\n");
  head = commit(repository, 'fix: load the page');
  env = { ...process.env, SKILL_ROOT_MAIN: roots };
  delete env.SKILL_ROOT_LOCAL;
});

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

function skills(args, environment = env) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: join(fixture, 'repository'),
    encoding: 'utf8',
    env: environment,
  });
}

const load = (root, skill) =>
  `  load ${root === 'roots' ? 'main' : 'local'}:${skill} from ${join(fixture, root, skill, 'SKILL.md')}`;

test('prints each required skill once with the rules and files that require it', () => {
  const result = skills(['required', base]);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(
    [
      `Required skills for ${base.slice(0, 12)}..${head.slice(0, 12)} (merge base to head): 5 files.`,
      '',
      'api-care',
      load('roots', 'api-care'),
      '  removed-exports: Exports.',
      '    src/api.ts (Gone, dropped)',
      '    src/legacy.cjs (old)',
      '  source: Source.',
      '    src/api.ts',
      '    src/client.ts',
      '    src/legacy.cjs',
      '',
      'big-review',
      load('roots', 'big-review'),
      '  large-change: Big.',
      '    <change> (4 changed lines)',
      '',
      'doc-style',
      load('repository/skills', 'doc-style'),
      '  docs: Docs.',
      '    docs/manual.md',
      '',
      'every-time',
      load('roots', 'every-time'),
      '  every-change: Always.',
      '    <change>',
      '',
      'export-care',
      load('roots', 'export-care'),
      '  removed-exports: Exports.',
      '    src/api.ts (Gone, dropped)',
      '    src/legacy.cjs (old)',
      '',
      'fix-care',
      load('roots', 'fix-care'),
      '  fix-commits: Fixes.',
      '    <change> (fix: load the page)',
      '',
      'move-care',
      `  read all of ${join(fixture, 'roots/move-care/SKILL.md')}`,
      '  moves: Moves.',
      '    docs/manual.md',
      '    src/legacy.cjs',
      '',
      'network-care',
      load('roots', 'network-care'),
      '  network: Network.',
      '    src/client.ts',
      '',
      'new-file-care',
      load('roots', 'new-file-care'),
      '  added: New.',
      '    src/client.ts',
      '',
      'Lessons from tools/skills/ledger.json:',
      '  client-retry (seen once): Retry a failed load once.',
      '    src/client.ts',
      '  head-watch (seen 2 times): Watch the pushed head.',
      '    <change>',
      '',
      'Enforced, so not listed: typed.',
      '',
    ].join('\n'),
  );
  expect(skills(['required', base, head]).stdout).toBe(result.stdout);
});

test('evaluates a planned file list by path and status only', () => {
  const result = skills([
    'required',
    '--plan',
    'src/api.ts',
    'A:notes/todo.md',
    'R:docs/a.md:docs/b.md',
    'R:src/old.ts:lib/old.ts',
  ]);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(
    [
      'Required skills for a planned change of 4 files.',
      'A plan has no content, so these rules were not evaluated: big-feature, fix-commits, large-change, network, removed-exports.',
      '',
      'api-care',
      load('roots', 'api-care'),
      '  source: Source.',
      '    lib/old.ts',
      '    src/api.ts',
      '',
      'doc-style',
      load('repository/skills', 'doc-style'),
      '  docs: Docs.',
      '    docs/b.md',
      '    notes/todo.md',
      '',
      'every-time',
      load('roots', 'every-time'),
      '  every-change: Always.',
      '    <change>',
      '',
      'move-care',
      `  read all of ${join(fixture, 'roots/move-care/SKILL.md')}`,
      '  moves: Moves.',
      '    docs/b.md',
      '    lib/old.ts',
      '',
      'new-file-care',
      load('roots', 'new-file-care'),
      '  added: New.',
      '    notes/todo.md',
      '',
      'Lessons from tools/skills/ledger.json:',
      '  head-watch (seen 2 times): Watch the pushed head.',
      '    <change>',
      '  lib-care (seen once): Library code needs care.',
      '    lib/old.ts',
      '',
      'Enforced, so not listed: typed.',
      '',
    ].join('\n'),
  );
});

test('fails clearly when a skill root is missing or a skill file is wrong', () => {
  const unset = { ...env };
  delete unset.SKILL_ROOT_MAIN;
  const missing = skills(['required', base], unset);
  expect(missing.status).toBe(1);
  expect(missing.stdout).toBe('');
  expect(missing.stderr).toBe(
    'Skill root main is not configured. Set SKILL_ROOT_MAIN to the directory that holds <skill>/SKILL.md.\n',
  );
  const absent = join(fixture, 'absent');
  expect(skills(['catalog'], { ...env, SKILL_ROOT_MAIN: absent }).stderr).toBe(
    `Skill root main does not exist at ${absent}. Set SKILL_ROOT_MAIN to the directory that holds <skill>/SKILL.md.\n`,
  );
  const file = join(fixture, 'roots/fix-care/SKILL.md');
  writeFileSync(file, '---\nname: other\n---\n');
  try {
    const renamed = skills(['catalog']);
    expect(renamed.status).toBe(1);
    expect(renamed.stderr).toBe(`${file} does not declare name: fix-care.\n`);
    writeFileSync(file, '---\ndescription: x\n---\nname: fix-care\n');
    const bodyName = skills(['catalog']);
    expect(bodyName.stderr).toBe(`${file} does not declare name: fix-care.\n`);
    expect(bodyName.status).toBe(1);
  } finally {
    writeFileSync(file, '---\nname: fix-care\n---\n');
  }
});

test('locks each skill hash with its headings and numbered rules outside code fences', () => {
  const file = join(fixture, 'roots/fix-care/SKILL.md');
  const text = [
    '---',
    'name: fix-care',
    '---',
    '# Fix care',
    '1. Read first.',
    '## Steps',
    '1. Reproduce.',
    '2. Fix.',
    '```sh',
    '# not a heading',
    '3. not a rule',
    '```',
    '## Limits',
    '',
  ].join('\n');
  const lock = join(fixture, 'repository/tools/skills/catalog.lock.json');
  writeFileSync(file, text);
  try {
    const result = skills(['catalog', '--lock']);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      'Wrote tools/skills/catalog.lock.json. Review a change to it like a check change.\n',
    );
    const locked = JSON.parse(readFileSync(lock, 'utf8')).skills;
    expect(Object.keys(locked)).toEqual(
      Object.keys(fixtureRouting.skills).sort(),
    );
    expect(locked['fix-care']).toEqual({
      sha256: createHash('sha256').update(text).digest('hex'),
      headings: ['Fix care', 'Steps', 'Limits'],
      rules: ['Fix care 1', 'Steps 1', 'Steps 2'],
    });
    expect(locked['fix-care']).not.toHaveProperty('files');
    expect(locked['big-review'].files).toEqual({
      'STANDARDS.md': {
        sha256: sha256(nestedFiles['STANDARDS.md']),
        headings: ['Standards', 'Easing'],
        rules: ['Easing 1'],
      },
      'references/alpha/SKILL.md': {
        sha256: sha256(nestedFiles['references/alpha/SKILL.md']),
        headings: ['Alpha', 'Critical Rules'],
        rules: [],
      },
    });
  } finally {
    writeFileSync(file, '---\nname: fix-care\n---\n');
    rmSync(lock, { force: true });
  }
});

test('fails the lock when a declared skill file is missing', () => {
  const file = join(fixture, 'roots/big-review/STANDARDS.md');
  const lock = join(fixture, 'repository/tools/skills/catalog.lock.json');
  renameSync(file, `${file}.moved`);
  try {
    const result = skills(['catalog', '--lock']);
    expect(result.stderr).toBe(
      `Skill big-review has no file STANDARDS.md (${file}).\n`,
    );
    expect(result.status).toBe(1);
  } finally {
    renameSync(`${file}.moved`, file);
    rmSync(lock, { force: true });
  }
});

test('the committed lock lists every catalogued skill', () => {
  const routing = parseRouting(
    readFileSync(resolve(__dirname, '../skills/routing.json'), 'utf8'),
  );
  const lock = JSON.parse(
    readFileSync(resolve(__dirname, '../skills/catalog.lock.json'), 'utf8'),
  );
  expect(Object.keys(lock.skills)).toEqual(Object.keys(routing.skills).sort());
});

test('the committed lock nests the review-animations standards and the nine Software Mansion references', () => {
  const lock = JSON.parse(
    readFileSync(resolve(__dirname, '../skills/catalog.lock.json'), 'utf8'),
  );
  const nested = Object.fromEntries(
    Object.entries(lock.skills)
      .filter(([, entry]) => entry.files)
      .map(([skill, entry]) => [skill, Object.keys(entry.files)]),
  );
  expect(Object.keys(nested).sort()).toEqual([
    'react-native-best-practices-sm',
    'review-animations',
  ]);
  expect(nested['review-animations']).toEqual(['STANDARDS.md']);
  const references = nested['react-native-best-practices-sm'];
  expect(references).toHaveLength(9);
  for (const path of references)
    expect(path).toMatch(/^references\/[a-z-]+\/SKILL\.md$/u);
});

test('rejects routing that names a skill outside the catalog', () => {
  const broken = {
    ...fixtureRouting,
    rules: [{ ...fixtureRouting.rules[0], skills: ['every-time', 'ghost'] }],
  };
  expect(() => parseRouting(JSON.stringify(broken))).toThrow(
    'Rule every-change names unknown skill ghost.',
  );
});

test('the committed routing names only catalogued skills and roots', () => {
  const text = readFileSync(
    resolve(__dirname, '../skills/routing.json'),
    'utf8',
  );
  expect(parseRouting(text).rules.length).toBeGreaterThan(0);
});

test.each([
  ['whose path has a space', 'spaced', 'src/my client.ts', ''],
  ['whose path git quotes', 'quoted', 'src/my "client".ts', ''],
  [
    'whose quoted path has escapes',
    'escaped',
    'src/back\\slash\tand \u001f é.ts',
    '',
  ],
  [
    'after an added line that looks like a diff header',
    'header-lookalike',
    'src/client.ts',
    '++ b/elsewhere.ts\n',
  ],
])('matches added lines in a file %s', (_, name, path, before) => {
  const repository = join(fixture, name);
  mkdirSync(repository);
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'core.hooksPath', '/dev/null']);
  git(repository, ['config', 'user.name', 'Skills fixture']);
  git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  const network = fixtureRouting.rules.find(rule => rule.id === 'network');
  write(
    repository,
    'tools/skills/routing.json',
    JSON.stringify({ ...fixtureRouting, rules: [network] }),
  );
  write(
    repository,
    'tools/skills/ledger.json',
    JSON.stringify({ lessons: [] }),
  );
  const start = commit(repository, 'Base');
  write(repository, path, `${before}export const load = () => fetch('/');\n`);
  commit(repository, 'feat: load the page');
  const result = spawnSync(process.execPath, [cli, 'required', start], {
    cwd: repository,
    encoding: 'utf8',
    env,
  });
  expect(result.stderr).toBe('');
  expect(result.stdout.split('\n').slice(2)).toEqual([
    'network-care',
    load('roots', 'network-care'),
    '  network: Network.',
    `    ${path}`,
    '',
  ]);
});

describe('a routing with tiers', () => {
  const tierRouting = {
    ...fixtureRouting,
    tiers: [
      {
        id: 'docs-only',
        why: 'Docs alone.',
        replaces: ['every-change'],
        excludePaths: ['generated/**'],
        paths: ['**/*.md'],
        skills: ['doc-style'],
      },
      {
        id: 'tiny',
        why: 'Small.',
        replaces: ['every-change'],
        excludePaths: ['generated/**'],
        maxFiles: 1,
        maxChangedLines: 2,
        status: ['modified'],
        unlessRules: ['source'],
        skills: ['tiny-care'],
      },
    ],
  };

  function withTiers(run) {
    const file = join(fixture, 'repository/tools/skills/routing.json');
    writeFileSync(file, JSON.stringify(tierRouting));
    try {
      return run();
    } finally {
      writeFileSync(file, JSON.stringify(fixtureRouting));
    }
  }

  test('a plan prints the docs-only tier, drops every-change, and keeps the file rules', () => {
    const result = withTiers(() =>
      skills([
        'required',
        '--plan',
        'docs/a.md',
        'A:notes/b.md',
        'generated/c.txt',
      ]),
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      [
        'Required skills for a planned change of 3 files.',
        'Tier docs-only replaces every-change: Docs alone.',
        'A plan has no content, so these rules were not evaluated: big-feature, fix-commits, large-change, network, removed-exports.',
        '',
        'doc-style',
        load('repository/skills', 'doc-style'),
        '  docs: Docs.',
        '    docs/a.md',
        '    notes/b.md',
        '  docs-only: Docs alone.',
        '    <change>',
        '',
        'new-file-care',
        load('roots', 'new-file-care'),
        '  added: New.',
        '    notes/b.md',
        '',
        'Lessons from tools/skills/ledger.json:',
        '  head-watch (seen 2 times): Watch the pushed head.',
        '    <change>',
        '',
        'Enforced, so not listed: typed.',
        '',
      ].join('\n'),
    );
  });

  test('a plan names the tiny tier among what it could not evaluate', () => {
    const result = withTiers(() => skills(['required', '--plan', 'lib/x.ts']));
    expect(result.stderr).toBe('');
    expect(result.stdout.split('\n').slice(0, 5)).toEqual([
      'Required skills for a planned change of 1 files.',
      'A plan has no content, so these rules were not evaluated: big-feature, fix-commits, large-change, network, removed-exports; and these tiers were not evaluated: tiny.',
      '',
      'every-time',
      load('roots', 'every-time'),
    ]);
  });

  test('a tiny range requires the tier skills in place of every-change, with its counts', () => {
    const routing = parseRouting(JSON.stringify(tierRouting));
    const change = {
      kind: 'range',
      files: [
        { status: 'modified', path: 'lib/util.ts' },
        { status: 'added', path: 'generated/data.txt' },
      ],
      lines: new Map([
        ['lib/util.ts', 2],
        ['generated/data.txt', 5],
      ]),
      added: new Map([
        ['lib/util.ts', ["export const b = () => fetch('/');"]],
        ['generated/data.txt', ['a', 'b', 'c', 'd', 'e']],
      ]),
      removedExports: new Map(),
      subjects: ['refactor: load b'],
    };
    const { tier, required } = requiredSkills(routing, change);
    expect(tier.id).toBe('tiny');
    expect(required).toEqual([
      {
        skill: 'network-care',
        reasons: [
          {
            rule: 'network',
            why: 'Network.',
            matches: [{ subject: 'lib/util.ts' }],
          },
        ],
      },
      {
        skill: 'tiny-care',
        reasons: [
          {
            rule: 'tiny',
            why: 'Small.',
            matches: [
              { subject: '<change>', detail: '1 file, 2 changed lines' },
            ],
          },
        ],
      },
    ]);
  });

  test('rejects a tier that names an unknown rule, a content rule, or an unknown skill', () => {
    const broken = {
      ...tierRouting,
      tiers: [
        {
          ...tierRouting.tiers[1],
          replaces: ['ghost-rule'],
          unlessRules: ['network', 'source'],
          skills: ['ghost'],
        },
      ],
    };
    expect(() => parseRouting(JSON.stringify(broken))).toThrow(
      'Tier tiny replaces unknown rule ghost-rule.\nTier tiny needs a path-only file rule, not network.\nTier tiny names unknown skill ghost.',
    );
  });
});
