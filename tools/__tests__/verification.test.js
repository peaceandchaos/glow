const { spawnSync } = require('node:child_process');
const {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  rmSync,
  existsSync,
  readdirSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const {
  git,
  withSnapshot,
  fingerprint,
} = require('../verification/snapshot.cjs');
const { evaluate } = require('../audit-check.cjs');
const security = require('../security-check.cjs');
const { checks, rangeChecks } = require('../verification/checks.cjs');
const { assertComplete } = require('../test-verified.cjs');

test('a real Jest run with a skipped case cannot become an accepted pass', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'skip-fixture-'));
  try {
    writeFileSync(
      join(fixture, 'skipped.test.js'),
      "test.skip('unfinished', () => {});\n",
    );
    const report = join(fixture, 'result.json');
    const result = spawnSync(
      process.execPath,
      [
        resolve('node_modules/jest/bin/jest.js'),
        '--config',
        JSON.stringify({ rootDir: fixture }),
        '--runInBand',
        '--json',
        '--outputFile',
        report,
      ],
      { cwd: fixture, encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    const data = JSON.parse(readFileSync(report, 'utf8'));
    expect(data.numPendingTests).toBe(1);
    expect(() => assertComplete(data, 'fixture')).toThrow('skipped');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function createFixture(check, message, extraScripts = {}) {
  const fixture = mkdtempSync(join(tmpdir(), 'verify-fixture-'));
  git(fixture, ['init', '--quiet']);
  git(fixture, ['config', 'core.hooksPath', '/dev/null']);
  git(fixture, ['config', 'user.name', 'Verification fixture']);
  git(fixture, ['config', 'user.email', 'fixture@example.invalid']);
  mkdirSync(join(fixture, 'tools/verification'), { recursive: true });
  mkdirSync(join(fixture, 'packages/app/src'), { recursive: true });
  for (const name of [
    'verify.cjs',
    'verification/snapshot.cjs',
    'verification/checks.cjs',
  ]) {
    copyFileSync(resolve(__dirname, '..', name), join(fixture, 'tools', name));
  }
  const scripts = { ...extraScripts };
  for (const args of [...Object.values(checks), ...Object.values(rangeChecks)])
    scripts[args[1]] = 'node check.cjs';
  writeFileSync(
    join(fixture, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', scripts }),
  );
  writeFileSync(
    join(fixture, 'package-lock.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': { name: 'fixture', version: '1.0.0' } },
    }),
  );
  writeFileSync(join(fixture, '.node-version'), process.versions.node);
  writeFileSync(
    join(fixture, '.gitignore'),
    'node_modules/\n.quality-results/\npackages/app/src/config.ts\n',
  );
  writeFileSync(
    join(fixture, 'packages/app/src/config.example.ts'),
    'export {};\n',
  );
  writeFileSync(join(fixture, 'check.cjs'), check);
  git(fixture, ['commit', '--quiet', '--allow-empty', '-m', 'Main']);
  git(fixture, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(fixture, ['add', '.']);
  git(fixture, ['commit', '--quiet', '-m', message]);
  return fixture;
}

const needsLocalFix = code =>
  `process.exit(require('node:fs').existsSync('node_modules/local-fix') ? 0 : ${code});\n`;

function verifyFixture(fixture, args, env = process.env) {
  return spawnSync(
    process.execPath,
    [resolve(__dirname, '../verify.cjs'), ...args],
    { cwd: fixture, encoding: 'utf8', env },
  );
}

test('personal npm configuration cannot skip install scripts in the snapshot', () => {
  const fixture = createFixture('process.exit(0);\n', 'Failing install', {
    postinstall: 'node -e "process.exit(7)"',
  });
  try {
    const result = verifyFixture(fixture, ['commit', 'HEAD'], {
      ...process.env,
      npm_config_ignore_scripts: 'true',
    });
    expect(result.stdout).toContain('install: FAIL');
    expect(result.status).toBe(1);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('committed and staged checks reject a broken tree despite an unstaged fix and local dependencies', () => {
  const fixture = createFixture(needsLocalFix(1), 'Broken fixture');
  try {
    const commit = git(fixture, ['rev-parse', 'HEAD']);
    const main = git(fixture, ['rev-parse', 'origin/main']);
    mkdirSync(join(fixture, 'node_modules'));
    writeFileSync(
      join(fixture, 'node_modules/local-fix'),
      'Must not enter the snapshot.',
    );
    expect(
      spawnSync(process.execPath, ['check.cjs'], { cwd: fixture }).status,
    ).toBe(0);
    writeFileSync(join(fixture, 'check.cjs'), 'process.exit(0);\n');
    // An unstaged change to the gate itself must not judge this commit.
    writeFileSync(
      join(fixture, 'tools/verification/checks.cjs'),
      'module.exports = {};\n',
    );
    const result = verifyFixture(fixture, ['commit', commit]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('install: PASS');
    expect(result.stdout).toContain('lint: FAIL');
    expect(result.stdout).toContain(`commit ${commit}`);
    expect(result.stdout).toContain('server-build: FAIL');
    const records = resultRecords(join(fixture, '.quality-results'));
    expect(records).toHaveLength(1);
    expect(
      records[0].results.map(({ name, command }) => [name, command]),
    ).toEqual([
      ['install', ['npm', 'ci', '--no-audit', '--no-fund']],
      ...Object.entries(checks).map(([name, args]) => [name, ['npm', ...args]]),
      ...Object.entries(rangeChecks).map(([name, args]) => [
        name,
        ['npm', ...args, main, commit],
      ]),
    ]);
    withSnapshot(fixture, 'staged', 'HEAD', checkout => {
      expect(existsSync(join(checkout, 'node_modules'))).toBe(false);
      expect(
        spawnSync(process.execPath, ['check.cjs'], { cwd: checkout }).status,
      ).toBe(1);
      // The real repository already has this source directory before the build.
      mkdirSync(join(checkout, 'packages/server'), { recursive: true });
      const before = fingerprint(checkout);
      mkdirSync(join(checkout, 'packages/server/.swc/plugins'), {
        recursive: true,
      });
      writeFileSync(
        join(checkout, 'packages/server/.swc/plugins/fixture.wasmer-v7'),
        'generated plugin cache',
      );
      expect(fingerprint(checkout)).toBe(before);
      writeFileSync(
        join(checkout, 'unexpected.ts'),
        'export const changed = true;',
      );
      expect(fingerprint(checkout)).not.toBe(before);
    });
    expect(readFileSync(join(fixture, 'check.cjs'), 'utf8')).toBe(
      'process.exit(0);\n',
    );

    writeFileSync(join(fixture, 'check.cjs'), needsLocalFix(2));
    git(fixture, ['add', 'check.cjs']);
    const badTree = git(fixture, ['write-tree']);
    writeFileSync(join(fixture, 'check.cjs'), 'process.exit(0);\n');
    const stagedFailure = verifyFixture(fixture, ['staged']);
    expect(stagedFailure.status).toBe(1);
    expect(stagedFailure.stdout).toContain('lint: FAIL');
    expect(stagedFailure.stdout).toContain(
      `staged: commit ${commit}, tree ${badTree}; FAIL`,
    );

    git(fixture, ['add', 'check.cjs']);
    const goodTree = git(fixture, ['write-tree']);
    writeFileSync(join(fixture, 'check.cjs'), 'process.exit(2);\n');
    const stagedPass = verifyFixture(fixture, ['staged']);
    expect(stagedPass.status).toBe(0);
    expect(stagedPass.stdout).toContain(
      `staged: commit ${commit}, tree ${goodTree}; PASS`,
    );
    expect(readdirSync(join(fixture, 'node_modules'))).toContain('local-fix');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function resultRecords(directory) {
  const records = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) records.push(...resultRecords(path));
    else if (entry.name === 'result.json')
      records.push(JSON.parse(readFileSync(path, 'utf8')));
  }
  return records;
}

test('verification output contains only records from the verified run', () => {
  const forged = {
    mode: 'commit',
    commit: 'forged',
    tree: 'forged',
    passed: true,
  };
  const writeForged = `const { mkdirSync, writeFileSync } = require('node:fs');
mkdirSync('.quality-results/0-forged', { recursive: true });
writeFileSync('.quality-results/0-forged/result.json', ${JSON.stringify(JSON.stringify(forged))});
`;
  const fixture = createFixture(writeForged, 'Passing fixture');
  try {
    const sourceRecords = join(fixture, '.quality-results');
    const runRecords = () =>
      readdirSync(sourceRecords)
        .filter(name => name !== '0-forged')
        .flatMap(name => resultRecords(join(sourceRecords, name)));

    const clean = verifyFixture(fixture, ['commit', 'HEAD']);
    const cleanCommit = git(fixture, ['rev-parse', 'HEAD']);
    expect(clean.status).toBe(0);
    expect(runRecords()).toEqual([
      expect.objectContaining({ commit: cleanCommit, passed: true }),
    ]);

    rmSync(sourceRecords, { recursive: true, force: true });
    mkdirSync(join(sourceRecords, '0-forged'), { recursive: true });
    writeFileSync(
      join(sourceRecords, '0-forged/result.json'),
      JSON.stringify(forged),
    );
    git(fixture, ['add', '--force', '.quality-results/0-forged']);
    git(fixture, ['commit', '--quiet', '-m', 'Forged result']);
    const tracked = verifyFixture(fixture, ['commit', 'HEAD']);
    expect(tracked.status).toBe(1);
    expect(tracked.stderr).toContain(
      'Tracked .quality-results files could forge verification records.',
    );
    expect(runRecords()).toEqual([]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('range checks receive the merge base and run only over a non-empty range', () => {
  const fixture = createFixture('process.exit(0);\n', 'Base fixture');
  try {
    const base = git(fixture, ['rev-parse', 'origin/main']);
    writeFileSync(join(fixture, 'change.txt'), 'change\n');
    git(fixture, ['add', 'change.txt']);
    git(fixture, ['commit', '--quiet', '-m', 'Change']);
    const head = git(fixture, ['rev-parse', 'HEAD']);
    const results = join(fixture, '.quality-results');
    const rangeResults = () => {
      const records = resultRecords(results);
      rmSync(results, { recursive: true, force: true });
      rmSync(join(fixture, 'node_modules'), { recursive: true, force: true });
      return records.map(record => ({
        base: record.base,
        required: record.required.filter(name => name in rangeChecks),
        commands: record.results
          .filter(result => result.name in rangeChecks)
          .map(result => result.command),
      }));
    };
    const ranged = {
      base,
      required: Object.keys(rangeChecks),
      commands: Object.values(rangeChecks).map(args =>
        ['npm'].concat(args, [base, head]),
      ),
    };

    const committed = verifyFixture(fixture, ['commit', 'HEAD']);
    expect(committed.status).toBe(0);
    expect(committed.stdout).toContain(`, base ${base} (2 commits); PASS\n`);
    expect(rangeResults()).toEqual([ranged]);

    const empty = verifyFixture(fixture, ['commit', 'HEAD', '--base', 'HEAD']);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain(
      `${head}..${head} has no commits, so the range checks would check nothing. Pass --base with a ref that the commit is ahead of.\n`,
    );
    expect(rangeResults()).toEqual([]);

    const missing = verifyFixture(fixture, [
      'commit',
      'HEAD',
      '--base',
      'gone',
    ]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe(
      `Cannot find the merge base of ${head} and gone. Fetch gone, or pass --base <ref>.\n`,
    );
    expect(rangeResults()).toEqual([]);

    const notRun = `PASS (range checks not run: ${Object.keys(rangeChecks).join(', ')})\n`;
    const unranged = verifyFixture(fixture, ['current']);
    expect(unranged.status).toBe(0);
    expect(unranged.stdout).toContain(
      `, tree ${git(fixture, ['rev-parse', 'HEAD^{tree}'])}; ${notRun}`,
    );
    const [unrangedRecord] = resultRecords(results);
    expect(unrangedRecord.notRun).toEqual(Object.keys(rangeChecks));
    expect(rangeResults()).toEqual([
      { base: undefined, required: [], commands: [] },
    ]);

    const emptyCurrent = verifyFixture(fixture, ['current', '--base', 'HEAD']);
    expect(emptyCurrent.status).toBe(0);
    expect(emptyCurrent.stdout).toContain(
      `, base ${head} (0 commits); ${notRun}`,
    );
    expect(resultRecords(results)[0].notRun).toEqual(Object.keys(rangeChecks));
    expect(rangeResults()).toEqual([
      { base: head, required: [], commands: [] },
    ]);

    const current = verifyFixture(fixture, [
      'current',
      '--base',
      'origin/main',
    ]);
    expect(current.status).toBe(0);
    expect(resultRecords(results)[0].notRun).toEqual([]);
    expect(rangeResults()).toEqual([ranged]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('dependency policy blocks high findings, missing reviews, expired reviews, and unavailable audits', () => {
  const url = 'https://github.com/advisories/fixture';
  const advisory = { url, range: '<2', severity: 'moderate' };
  const finding = { severity: 'moderate', via: [advisory] };
  const audit = {
    auditReportVersion: 2,
    vulnerabilities: { fixture: finding },
    metadata: { dependencies: { total: 1 } },
  };
  const review = {
    [url]: {
      range: '<2',
      decision: 'track',
      reviewBy: '2026-10-01',
      reason: 'No affected caller in the reviewed path.',
    },
  };
  expect(evaluate(audit, review, '2026-09-29')).toEqual([]);
  expect(evaluate(audit, {}, '2026-09-29')).toHaveLength(1);
  expect(evaluate(audit, review, '2026-10-02')).toHaveLength(1);
  finding.severity = 'high';
  expect(evaluate(audit, review, '2026-09-29')).toContain('fixture: high');
  expect(() => evaluate({ error: 'offline' }, review, '2026-09-29')).toThrow(
    'Audit response',
  );
});

test('a high advisory with no fixed release passes only under a current, exact track-unpatched disposition', () => {
  const url = 'https://github.com/advisories/unpatched';
  const advisory = {
    name: 'braces',
    dependency: 'braces',
    url,
    range: '<=3.0.3',
    severity: 'high',
  };
  const audit = {
    auditReportVersion: 2,
    vulnerabilities: {
      braces: { severity: 'high', via: [advisory] },
      micromatch: { severity: 'high', via: ['braces'] },
      jest: { severity: 'high', via: ['micromatch'] },
    },
    metadata: { dependencies: { total: 3 } },
  };
  const tracked = {
    package: 'braces',
    range: '<=3.0.3',
    severity: 'high',
    decision: 'track-unpatched',
    latest: '3.0.3',
    reviewedAt: '2026-10-03',
    reviewBy: '2026-10-17',
    reason: 'No fixed release exists. Only build and test tools load it.',
  };
  const registry = (latest = '3.0.3', unfixed = true) => ({
    latest: () => latest,
    unfixed: () => unfixed,
  });
  const check = (disposition, today = '2026-10-03', npm = registry()) =>
    evaluate(audit, disposition ? { [url]: disposition } : {}, today, npm);
  const blocked = ['braces: high', 'micromatch: high', 'jest: high'];
  const blocks = disposition =>
    expect(check(disposition)).toEqual(expect.arrayContaining(blocked));

  expect(check(tracked)).toEqual([]);
  expect(check(tracked, '2026-10-17')).toEqual([]);
  expect(check(tracked, '2026-10-18')).toEqual(expect.arrayContaining(blocked));
  blocks(undefined);
  blocks({ ...tracked, decision: 'track' });
  blocks({ ...tracked, package: 'micromatch' });
  blocks({ ...tracked, range: '<=3.0.2' });
  blocks({ ...tracked, severity: 'moderate' });
  blocks({ ...tracked, reviewBy: '2026-10-18' });
  blocks({ ...tracked, reviewBy: '2026-10-1' });
  blocks({ ...tracked, reviewedAt: '2026-10-04' });
  blocks({ ...tracked, reviewedAt: undefined });
  blocks({ ...tracked, reason: '  ' });
  blocks({ ...tracked, latest: undefined });
  blocks({ ...tracked, reviewedAt: '2026-10-01x' });
  expect(
    check({ ...tracked, latest: null }, '2026-10-03', registry(null)),
  ).toEqual(expect.arrayContaining(blocked));
  expect(check({ ...tracked, reviewBy: '2026-10-18' }, '2026-10-05')).toEqual(
    expect.arrayContaining(blocked),
  );
  expect(check(tracked, '2026-10-03', registry('3.0.4'))).toEqual(
    expect.arrayContaining([
      ...blocked,
      expect.stringContaining('braces 3.0.4 is released'),
    ]),
  );
  expect(
    check(
      { ...tracked, latest: '3.0.4' },
      '2026-10-03',
      registry('3.0.4', false),
    ),
  ).toEqual(
    expect.arrayContaining([
      ...blocked,
      expect.stringContaining('has a release outside <=3.0.3'),
    ]),
  );

  audit.vulnerabilities.jest.via.push('ghost');
  expect(check(tracked)).toEqual(['jest: high']);
  audit.vulnerabilities.jest.via.pop();

  audit.vulnerabilities.jest.severity = 'critical';
  expect(check(tracked)).toEqual(['jest: critical']);
  audit.vulnerabilities.jest.severity = 'high';

  advisory.severity = 'critical';
  audit.vulnerabilities.braces.severity = 'critical';
  expect(check({ ...tracked, severity: 'critical' })).toEqual(
    expect.arrayContaining(['braces: critical', 'micromatch: high']),
  );
  advisory.severity = 'high';
  audit.vulnerabilities.braces.severity = 'high';

  audit.vulnerabilities.micromatch.via.push({
    name: 'micromatch',
    dependency: 'micromatch',
    url: 'https://github.com/advisories/second',
    range: '<4.0.9',
    severity: 'high',
  });
  const second = check(tracked);
  expect(second).toEqual(
    expect.arrayContaining(['micromatch: high', 'jest: high']),
  );
  expect(second).not.toContain('braces: high');
  audit.vulnerabilities.micromatch.via.pop();

  const sharedUrl = names => ({
    ...audit,
    vulnerabilities: Object.fromEntries(
      names.map(name => [
        name,
        {
          severity: 'high',
          via: [
            {
              ...advisory,
              name,
              dependency: name,
              range: name === 'braces' ? '<=3.0.3' : '<2.0.1',
            },
          ],
        },
      ]),
    ),
  });
  for (const names of [
    ['fixed-pkg', 'braces'],
    ['braces', 'fixed-pkg'],
  ]) {
    const result = evaluate(
      sharedUrl(names),
      { [url]: tracked },
      '2026-10-03',
      registry(),
    );
    expect(result).toEqual([
      `fixed-pkg: ${url} has a track-unpatched disposition for another package, range or severity`,
      'fixed-pkg: high',
    ]);
  }

  expect(() =>
    evaluate(
      {
        ...audit,
        vulnerabilities: {
          braces: {
            severity: 'high',
            via: [{ ...advisory, severity: 'CRITICAL' }],
          },
        },
      },
      {},
      '2026-10-03',
      registry(),
    ),
  ).toThrow('Unknown advisory severity');

  const moderateOnly = {
    ...audit,
    vulnerabilities: {
      fixture: {
        severity: 'moderate',
        via: [
          {
            ...advisory,
            url: 'https://github.com/advisories/other',
            severity: 'moderate',
          },
        ],
      },
    },
  };
  expect(
    evaluate(
      moderateOnly,
      {
        'https://github.com/advisories/other': {
          ...tracked,
          decision: 'track',
          range: '<=3.0.3',
          reviewBy: '2026-10-29',
        },
        [url]: tracked,
      },
      '2026-10-03',
      registry(),
    ),
  ).toEqual([`${url}: track-unpatched disposition matches no high advisory`]);
});

test('the registry lookup counts any release outside the advisory range as a fix', () => {
  const bin = mkdtempSync(join(tmpdir(), 'fake-npm-'));
  const url = 'https://github.com/advisories/unpatched';
  const audit = {
    auditReportVersion: 2,
    vulnerabilities: {
      'fixture-pkg': {
        severity: 'high',
        via: [{ name: 'fixture-pkg', url, range: '<=3.0.3', severity: 'high' }],
      },
    },
    metadata: { dependencies: { total: 1 } },
  };
  const dispositions = {
    [url]: {
      package: 'fixture-pkg',
      range: '<=3.0.3',
      severity: 'high',
      decision: 'track-unpatched',
      latest: '3.0.3',
      reviewedAt: '2026-10-03',
      reviewBy: '2026-10-17',
      reason: 'No fixed release exists.',
    },
  };
  const check = versions => {
    writeFileSync(
      join(bin, 'npm'),
      `#!/usr/bin/env node
const answer = {
  'view fixture-pkg version --json': '"3.0.3"',
  'view fixture-pkg@<=3.0.3 version --json': '["3.0.2","3.0.3"]',
  'view fixture-pkg versions --json': ${JSON.stringify(JSON.stringify(versions))},
}[process.argv.slice(2).join(' ')];
if (answer === undefined) process.exit(1);
process.stdout.write(answer);
`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const { evaluate } = require(${JSON.stringify(join(__dirname, '../audit-check.cjs'))});
process.stdout.write(JSON.stringify(evaluate(${JSON.stringify(audit)}, ${JSON.stringify(dispositions)}, '2026-10-03')));`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(result.stderr).toBe('');
    return JSON.parse(result.stdout);
  };
  try {
    expect(check(['3.0.2', '3.0.3'])).toEqual([]);
    expect(check(['3.0.2', '3.0.3', '3.0.4'])).toEqual([
      `fixture-pkg: ${url} may be fixed, because fixture-pkg has a release outside <=3.0.3`,
      'fixture-pkg: high',
    ]);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test('one advisory listed twice for one package must match the disposition both times, and impossible dates fail', () => {
  const url = 'https://github.com/advisories/twice';
  const instance = range => ({ name: 'braces', url, range, severity: 'high' });
  const audit = ranges => ({
    auditReportVersion: 2,
    vulnerabilities: {
      braces: { severity: 'high', via: ranges.map(instance) },
    },
    metadata: { dependencies: { total: 1 } },
  });
  const tracked = {
    package: 'braces',
    range: '<=3.0.3',
    severity: 'high',
    decision: 'track-unpatched',
    latest: '3.0.3',
    reviewedAt: '2026-10-03',
    reviewBy: '2026-10-17',
    reason: 'No fixed release exists.',
  };
  const registry = { latest: () => '3.0.3', unfixed: () => true };
  const run = (ranges, disposition = tracked) =>
    evaluate(audit(ranges), { [url]: disposition }, '2026-10-03', registry);

  expect(run(['<=3.0.3'])).toEqual([]);
  for (const ranges of [
    ['<2.3.1', '<=3.0.3'],
    ['<=3.0.3', '<2.3.1'],
  ])
    expect(run(ranges)).toEqual([
      `braces: ${url} has a track-unpatched disposition for another package, range or severity`,
      'braces: high',
    ]);
  expect(
    evaluate(
      audit(['<=3.0.3']),
      {
        [url]: { ...tracked, reviewedAt: '2026-02-31', reviewBy: '2026-03-17' },
      },
      '2026-03-01',
      registry,
    ),
  ).toEqual([
    `braces: ${url} needs a reviewedAt date no later than today, and a reviewBy date from today to 14 days after reviewedAt`,
    'braces: high',
  ]);
  for (const reviewedAt of ['2026-02-31', '2026-10-00'])
    expect(run(['<=3.0.3'], { ...tracked, reviewedAt })).toContain(
      'braces: high',
    );
});

test('app security policy fails a real undisposed MEDIUM finding, keeps HIGH blocking, and leaves dependency advisories to audit:check', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'security-fixture-'));
  try {
    writeFileSync(
      join(fixture, 'Chat.ts'),
      "export const socket = new WebSocket('ws://example.invalid/chat');\n",
    );
    const report = security.scan(fixture);
    expect(report.findings).toEqual([
      expect.objectContaining({
        ruleId: 'INSECURE_WEBSOCKET',
        severity: 'MEDIUM',
      }),
    ]);
    const key = 'INSECURE_WEBSOCKET Chat.ts:1';
    const disposition = {
      severity: 'MEDIUM',
      reviewedAt: '2026-09-29',
      reviewBy: '2026-10-01',
      reason: 'Fixture socket never leaves the test host.',
    };
    expect(security.evaluate(report, {}, '2026-09-29', fixture)).toEqual([
      `${key}: MEDIUM needs a current disposition`,
    ]);
    expect(
      security.evaluate(report, { [key]: disposition }, '2026-09-29', fixture),
    ).toEqual([]);
    expect(
      security.evaluate(report, { [key]: disposition }, '2026-10-02', fixture),
    ).toEqual([`${key}: MEDIUM needs a current disposition`]);

    const finding = (ruleId, severity) => ({
      ruleId,
      severity,
      filePath: join(fixture, 'package.json'),
      line: 3,
    });
    const scanned = findings => ({
      findings,
      scannedFiles: 1,
      ignoredRules: [],
    });
    expect(
      security.evaluate(
        scanned([finding('NPM_VULNERABLE_DEPENDENCY', 'MEDIUM')]),
        {},
        '2026-09-29',
        fixture,
      ),
    ).toEqual([]);
    expect(
      security.evaluate(
        scanned([finding('NPM_VULNERABLE_DEPENDENCY', 'HIGH')]),
        {},
        '2026-09-29',
        fixture,
      ),
    ).toEqual([]);
    expect(
      security.evaluate(
        scanned([finding('DEPRECATED_NPM_PACKAGE', 'LOW')]),
        {},
        '2026-09-29',
        fixture,
      ),
    ).toEqual([
      'DEPRECATED_NPM_PACKAGE package.json:3: LOW needs a current disposition',
    ]);
    const highKey = 'HARDCODED_SECRET package.json:3';
    expect(
      security.evaluate(
        scanned([finding('HARDCODED_SECRET', 'HIGH')]),
        { [highKey]: { ...disposition, severity: 'HIGH' } },
        '2026-09-29',
        fixture,
      ),
    ).toEqual([
      `${highKey}: HIGH has no exceptions`,
      `${highKey}: disposition matches no finding`,
    ]);
    expect(
      security.evaluate(
        { ...scanned([]), ignoredRules: ['INSECURE_WEBSOCKET'] },
        {},
        '2026-09-29',
        fixture,
      ),
    ).toEqual([
      'rnsec ignores INSECURE_WEBSOCKET; record dispositions instead.',
    ]);
    expect(() =>
      security.evaluate(
        { ...scanned([]), scannedFiles: 0 },
        {},
        '2026-09-29',
        fixture,
      ),
    ).toThrow('scanned no files');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
