const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const {
  loadInstruction,
  parseRouting,
  requiredSkills,
} = require('../skills/routing.cjs');
const { mustMatch, mustNotMatch } = require('./motion-lines.cjs');

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
  const theme = 'packages/app/src/theme.ts';
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

  const everyChange = [
    'deslop',
    'no-comments',
    'principle-prove-it-works',
    'principle-sequence-verifiable-units',
    'technical-writing',
    'unslop',
  ];
  const docsOnly = ['technical-writing', 'unslop'];
  const tiny = ['principle-prove-it-works', 'technical-writing', 'unslop'];
  const typescript = [
    'principle-type-system-discipline',
    'typescript-best-practices',
  ];
  const reactNative = [
    'react-native-best-practices',
    'react-native-best-practices-sm',
  ];
  const ui = ['expo-ios-hig'];
  const motion = ['expo-animation', 'review-animations'];
  const controls = [
    'blast-radius',
    'principle-test-behavior-not-implementation',
  ];
  const moves = [
    'blast-radius',
    'principle-migrate-callers-then-delete-legacy-apis',
  ];
  const addedFiles = [
    'principle-minimize-reader-load',
    'principle-subtract-before-you-add',
  ];

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
      [docsOnly],
    ],
    [
      'a normal screen change',
      [{ path: screen, added: plain(60) }],
      null,
      [everyChange, typescript, reactNative, ui],
    ],
    [
      'a tiny UI tweak',
      [{ path: recents, added: plain(6) }],
      'tiny',
      [tiny, typescript, reactNative, ui],
    ],
    [
      'an animated component',
      [{ path: shimmer, added: [...animated, ...plain(23)] }],
      null,
      [everyChange, typescript, reactNative, ui, motion],
    ],
    [
      'a tiny animated tweak',
      [{ path: shimmer, added: animated }],
      'tiny',
      [tiny, typescript, reactNative, ui, motion],
    ],
    [
      'a tiny animated tweak with a gesture',
      [{ path: shimmer, added: [...animated, 'const pan = Gesture.Pan();'] }],
      'tiny',
      [tiny, typescript, reactNative, ui, motion],
    ],
    [
      'a motion token tune',
      [{ path: theme, added: ['  fast: 150,'] }],
      'tiny',
      [tiny, typescript, reactNative, motion],
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
      [
        everyChange,
        typescript,
        reactNative,
        ['principle-test-behavior-not-implementation', 'test-prune'],
      ],
    ],
  ])('routes %s', (_, files, tier, groups) => {
    expect(routed(range(files))).toEqual({ tier, skills: skillsOf(...groups) });
  });

  test.each([
    [
      'a new doc',
      [{ status: 'added', path: 'docs/new.md', lines: 5 }],
      'docs-only',
      [docsOnly, addedFiles],
    ],
    [
      'a doc with fetch( in a code sample',
      [
        {
          path: 'docs/providers.md',
          added: ["const reply = await fetch('/chat');"],
        },
      ],
      'docs-only',
      [docsOnly, ['principle-boundary-discipline']],
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
      [docsOnly, moves],
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
      [everyChange, ['writing-for-agents']],
    ],
    [
      'a 2-line skill edit',
      [{ path: '.agents/skills/test-prune/SKILL.md', lines: 2 }],
      'tiny',
      [tiny, ['writing-for-agents']],
    ],
    [
      'a 2-line AGENTS.md edit',
      [{ path: 'AGENTS.md', lines: 2 }],
      null,
      [everyChange, ['writing-for-agents'], controls],
    ],
    [
      'a 2-line check edit',
      [{ path: 'tools/skills/routing.cjs', lines: 2 }],
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
      [everyChange, typescript, moves],
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
      [everyChange, typescript, reactNative, ui, addedFiles],
    ],
    [
      '20 changed lines',
      [{ path: recents, added: plain(20) }],
      'tiny',
      [tiny, typescript, reactNative, ui],
    ],
    [
      '21 changed lines',
      [{ path: recents, added: plain(21) }],
      null,
      [everyChange, typescript, reactNative, ui],
    ],
    [
      '2 files of 2 lines',
      [
        { path: recents, added: plain(2) },
        { path: screen, added: plain(2) },
      ],
      'tiny',
      [tiny, typescript, reactNative, ui],
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
      [everyChange, typescript, reactNative, ui],
    ],
    ['only a skill record', [], null, [everyChange]],
  ])('pins the tier edge for %s', (_, files, tier, groups) => {
    expect(routed(range(files))).toEqual({ tier, skills: skillsOf(...groups) });
  });

  test('a fix commit inside a tiny change still requires the root-cause skill', () => {
    const change = range(
      [{ path: recents, added: plain(6) }],
      ['fix: pad the recents row'],
    );
    expect(routed(change)).toEqual({
      tier: 'tiny',
      skills: skillsOf(tiny, typescript, reactNative, ui, [
        'principle-fix-root-causes',
      ]),
    });
  });

  test('a plan evaluates docs-only and leaves tiny and the motion rules unevaluated', () => {
    expect(routed(plan(['docs/providers.md', 'README.md']))).toEqual({
      tier: 'docs-only',
      skills: docsOnly,
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
    expect(skipped).toEqual(
      expect.arrayContaining(['motion-lines', 'motion-tokens']),
    );
    expect(skippedTiers).toEqual(['tiny']);
  });

  test.each([
    ['press: 120', '  press: 120,'],
    ['shimmer: 1500', '  shimmer: 1500,'],
    [
      'a motion token object',
      'export const motionTokens = { fast: 150, base: 200 } as const;',
    ],
  ])(
    'motion-tokens alone routes the motion skills for %s in theme.ts',
    (_, line) => {
      const { required } = requiredSkills(
        routing,
        range([{ path: theme, added: [line] }]),
      );
      const rules = skill =>
        required
          .find(entry => entry.skill === skill)
          ?.reasons.map(({ rule }) => rule);
      expect(rules('expo-animation')).toEqual(['motion-tokens']);
      expect(rules('review-animations')).toEqual(['motion-tokens']);
    },
  );

  test('motion-tokens ignores a style value outside theme.ts', () => {
    expect(
      routed(range([{ path: screen, added: ['    width: 120,'] }])),
    ).toEqual({
      tier: 'tiny',
      skills: skillsOf(tiny, typescript, reactNative, ui),
    });
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

  test.each(mustMatch)('motion-lines matches %s', (_, line) => {
    const rule = routing.rules.find(({ id }) => id === 'motion-lines');
    expect(rule.addedLines.test(line)).toBe(true);
  });

  test.each(mustNotMatch)('motion-lines ignores %s', (_, line) => {
    const rule = routing.rules.find(({ id }) => id === 'motion-lines');
    expect(rule.addedLines.test(line)).toBe(false);
  });
});
