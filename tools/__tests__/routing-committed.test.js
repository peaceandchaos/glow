const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const {
  loadInstruction,
  parseRouting,
  requiredSkills,
} = require('../skills/routing.cjs');

describe('the committed routing', () => {
  let routing;
  beforeAll(() => {
    routing = parseRouting(
      readFileSync(resolve(__dirname, '../skills/routing.json'), 'utf8'),
    );
  });

  const record = {
    status: 'added',
    path: 'tools/skills/records/routing-tune.json',
    lines: 80,
  };
  const plain = count =>
    Array.from(
      { length: count },
      (_, index) => `const row${index} = ${index};`,
    );
  const screen = 'packages/app/src/screens/ChatScreen.tsx';
  const recents = 'packages/app/src/screens/RecentsScreen.tsx';
  const shimmer = 'packages/app/src/components/ShimmerText.tsx';
  const animated = [
    'const reduceMotion = useReducedMotion();',
    'const shimmerOff = reduceMotion;',
  ];

  // Every real change adds its record, so each built change carries one.
  function range(files, subjects = ['feat: tune']) {
    const all = [...files, record];
    return {
      kind: 'range',
      files: all.map(({ status = 'modified', from, path }) =>
        from ? { status, from, path } : { status, path },
      ),
      lines: new Map(
        all.map(file => [file.path, file.lines ?? file.added.length]),
      ),
      added: new Map(all.map(file => [file.path, file.added ?? []])),
      removedExports: new Map(),
      subjects,
    };
  }
  const plan = paths => ({
    kind: 'plan',
    files: paths.map(path => ({ status: 'modified', path })),
  });
  function routed(change) {
    const { tier, required } = requiredSkills(routing, change);
    return {
      tier: tier?.id ?? null,
      skills: required.map(({ skill }) => skill),
    };
  }
  const skillsOf = (...groups) => [...new Set(groups.flat())].sort();

  const everyChange = ['deslop', 'no-comments', 'principle-prove-it-works'];
  const quality = ['thermo-nuclear-code-quality-review'];
  const docsOnly = ['technical-writing', 'unslop'];
  const tiny = ['principle-prove-it-works', 'technical-writing', 'unslop'];
  const reactNative = ['react-native-best-practices'];
  const server = ['typescript-best-practices'];
  const boundary = ['principle-boundary-discipline'];
  const native = ['ios-debugger-agent'];
  const agentInstructions = ['unslop', 'writing-for-agents'];
  const controls = ['blast-radius'];

  test('catalogues the routed and the optional motion skills', () => {
    const names = [
      'emil-prototype',
      'expo-animation',
      'expo-ios-hig',
      'find-animation-opportunities',
      'principle-experience-first',
      'review-animations',
    ];
    expect(
      Object.fromEntries(names.map(name => [name, routing.skills[name]])),
    ).toEqual({
      'emil-prototype': 'user',
      'expo-animation': 'user',
      'expo-ios-hig': 'user',
      'find-animation-opportunities': 'user',
      'principle-experience-first': 'pstack',
      'review-animations': 'user',
    });
  });

  test.each([
    [
      'a docs edit',
      [{ path: 'docs/providers.md', lines: 3 }],
      'docs-only',
      [docsOnly, controls],
    ],
    [
      'a 500-line docs edit',
      [{ path: 'docs/providers.md', lines: 500 }],
      'docs-only',
      [docsOnly, controls],
    ],
    [
      'a normal screen change',
      [{ path: screen, added: plain(60) }],
      null,
      [everyChange, quality, reactNative],
    ],
    [
      'a tiny UI tweak',
      [{ path: recents, added: plain(6) }],
      'tiny',
      [tiny, reactNative],
    ],
    [
      'an animated component',
      [{ path: shimmer, added: [...animated, ...plain(23)] }],
      null,
      [everyChange, quality, reactNative],
    ],
    [
      'a UI test file',
      [
        {
          path: 'packages/app/src/components/__tests__/Row.test.tsx',
          added: plain(30),
        },
      ],
      null,
      [everyChange, quality, reactNative],
    ],
    [
      'an app config change',
      [{ path: 'packages/app/src/config.ts', added: plain(30) }],
      null,
      [everyChange, quality, reactNative, boundary],
    ],
    [
      'a server change',
      [{ path: 'packages/server/src/models.ts', added: plain(30) }],
      null,
      [everyChange, quality, server],
    ],
    [
      'a server boundary change',
      [{ path: 'packages/server/src/api.ts', added: plain(30) }],
      null,
      [everyChange, quality, server, boundary],
    ],
    [
      'a native iOS change',
      [{ path: 'packages/app/ios/Podfile', added: plain(30) }],
      null,
      [everyChange, quality, native, controls],
    ],
  ])('routes %s', (_, files, tier, groups) => {
    expect(routed(range(files))).toEqual({ tier, skills: skillsOf(...groups) });
  });

  test.each([
    [
      'a new doc',
      [{ status: 'added', path: 'docs/new.md', lines: 5 }],
      'docs-only',
      [docsOnly, controls],
    ],
    [
      'a renamed doc',
      [
        {
          status: 'renamed',
          from: 'docs/old.md',
          path: 'docs/new.md',
          lines: 0,
        },
      ],
      'docs-only',
      [docsOnly, controls],
    ],
    [
      'an upstream note under tools',
      [{ path: 'tools/vendor/anti-slop/UPSTREAM.md', lines: 2 }],
      'docs-only',
      [docsOnly, controls],
    ],
    [
      'a 30-line skill edit',
      [{ path: '.agents/skills/test-prune/SKILL.md', lines: 30 }],
      null,
      [everyChange, quality, agentInstructions, controls],
    ],
    [
      'a 2-line skill edit',
      [{ path: '.agents/skills/test-prune/SKILL.md', lines: 2 }],
      null,
      [everyChange, quality, agentInstructions, controls],
    ],
    [
      'a 2-line AGENTS.md edit',
      [{ path: 'AGENTS.md', lines: 2 }],
      null,
      [everyChange, quality, docsOnly, agentInstructions, controls],
    ],
    [
      'a 2-line check edit',
      [{ path: 'tools/skills/routing.cjs', lines: 2 }],
      null,
      [everyChange, quality, controls],
    ],
    [
      'a lockfile-only change',
      [{ path: 'package-lock.json', lines: 300 }],
      null,
      [everyChange, controls],
    ],
    [
      'a 2-line rename',
      [
        {
          status: 'renamed',
          from: 'packages/server/src/helpers.ts',
          path: 'packages/server/src/text.ts',
          lines: 2,
        },
      ],
      null,
      [everyChange, quality, server],
    ],
    [
      'a 2-line change that adds a file',
      [
        {
          status: 'added',
          path: 'packages/app/src/components/Badge.tsx',
          added: plain(2),
        },
      ],
      null,
      [everyChange, quality, reactNative],
    ],
    [
      '20 changed lines',
      [{ path: recents, added: plain(20) }],
      'tiny',
      [tiny, reactNative],
    ],
    [
      '21 changed lines',
      [{ path: recents, added: plain(21) }],
      null,
      [everyChange, quality, reactNative],
    ],
    [
      '2 files of 2 lines',
      [
        { path: recents, added: plain(2) },
        { path: screen, added: plain(2) },
      ],
      'tiny',
      [tiny, reactNative],
    ],
    [
      '3 files of 2 lines',
      [
        { path: recents, added: plain(2) },
        { path: screen, added: plain(2) },
        {
          path: 'packages/app/src/screens/SettingsScreen.tsx',
          added: plain(2),
        },
      ],
      null,
      [everyChange, quality, reactNative],
    ],
    ['only a skill record', [], null, [everyChange]],
  ])('pins the tier edge for %s', (_, files, tier, groups) => {
    expect(routed(range(files))).toEqual({ tier, skills: skillsOf(...groups) });
  });

  test.each([
    [
      'an app component',
      ['packages/app/src/components/Header.tsx'],
      [everyChange, quality, reactNative],
    ],
    [
      'a server boundary',
      ['packages/server/src/api.ts'],
      [everyChange, quality, server, boundary],
    ],
    ['a readme', ['README.md'], [docsOnly, controls]],
  ])('a plan for %s lists the slim skill set', (_, paths, groups) => {
    expect(routed(plan(paths)).skills).toEqual(skillsOf(...groups));
  });

  test('a plan evaluates every rule and docs-only, and leaves tiny unevaluated', () => {
    expect(routed(plan(['docs/providers.md', 'README.md']))).toEqual({
      tier: 'docs-only',
      skills: skillsOf(docsOnly, controls),
    });
    for (const paths of [
      ['AGENTS.md', 'docs/providers.md'],
      ['.agents/skills/test-prune/SKILL.md'],
    ])
      expect(routed(plan(paths)).tier).toBeNull();
    const { tier, skipped, skippedTiers } = requiredSkills(
      routing,
      plan([shimmer]),
    );
    expect(tier).toBeNull();
    expect(skipped).toEqual([]);
    expect(skippedTiers).toEqual(['tiny']);
  });

  const invocable = '---\nname: x\n---\n';
  const readOnly = '---\nname: x\ndisable-model-invocation: true\n---\n';
  test.each([
    [
      'react-native-best-practices-sm',
      invocable,
      'load glow-guides:react-native-best-practices-sm from f',
    ],
    ['unslop', invocable, 'load pstack:unslop from f'],
    ['tdd', invocable, 'load tdd from f'],
    ['test-prune', invocable, 'read all of f'],
    ['review-animations', readOnly, 'read all of f'],
  ])('skills:required tells the author how to load %s', (skill, text, line) => {
    expect(loadInstruction(routing, skill, 'f', text)).toBe(line);
  });
});
