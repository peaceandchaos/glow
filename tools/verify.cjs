const { spawnSync } = require('node:child_process');
const {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  openSync,
  closeSync,
} = require('node:fs');
const { resolve, join } = require('node:path');
const {
  git,
  identity,
  withSnapshot,
  fingerprint,
  cleanEnvironment,
} = require('./verification/snapshot.cjs');
const { checks, rangeChecks } = require('./verification/checks.cjs');

const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
const [mode, ...rest] = process.argv.slice(2);
const baseFlag = rest.indexOf('--base');
const baseRef = baseFlag === -1 ? null : rest[baseFlag + 1];
const positional = baseFlag === -1 ? rest : rest.toSpliced(baseFlag, 2);
const ref = positional[0] ?? 'HEAD';
// A checkout run writes only where its caller asks, never inside the candidate.
const output = mode?.endsWith('-checkout')
  ? resolve(positional[0])
  : resolve(root, '.quality-results', `${Date.now()}-${process.pid}`);
mkdirSync(output, { recursive: true });
const userConfig = join(output, 'user.npmrc');
const globalConfig = join(output, 'global.npmrc');
writeFileSync(userConfig, '');
writeFileSync(globalConfig, '');

function run(directory, name, args) {
  const logPath = join(output, `${name}.log`);
  const log = openSync(logPath, 'w');
  let result;
  try {
    result = spawnSync('npm', args, {
      cwd: directory,
      env: {
        ...cleanEnvironment(),
        CI: '1',
        npm_config_userconfig: userConfig,
        npm_config_globalconfig: globalConfig,
      },
      stdio: ['ignore', log, log],
      timeout: 10 * 60 * 1000,
    });
  } finally {
    closeSync(log);
  }
  const passed = result.status === 0 && !result.error && !result.signal;
  console.log(`${name}: ${passed ? 'PASS' : 'FAIL'} (${logPath})`);
  if (!passed)
    console.error(
      readFileSync(logPath, 'utf8').split('\n').slice(-45).join('\n'),
    );
  return {
    name,
    command: ['npm', ...args],
    passed,
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
  };
}

function fixtureConfig(directory) {
  const example = join(directory, 'packages/app/src/config.example.ts');
  const config = join(directory, 'packages/app/src/config.ts');
  if (
    existsSync(config) &&
    !readFileSync(config).equals(readFileSync(example))
  ) {
    throw new Error(
      'Verification accepts only the committed example config. Use verify:commit for a personal checkout.',
    );
  }
  copyFileSync(example, config);
}

function mergeBase(commit, base) {
  try {
    return git(root, ['merge-base', base, commit]);
  } catch {
    throw new Error(
      `Cannot find the merge base of ${commit} and ${base}. Fetch ${base}, or pass --base <ref>.`,
    );
  }
}

function planRanges(directory, { mode, base, commit }) {
  const rangeCommits = base
    ? Number(git(directory, ['rev-list', '--count', `${base}..${commit}`]))
    : 0;
  if (mode === 'commit' && !rangeCommits)
    throw new Error(
      `${base}..${commit} has no commits, so the range checks would check nothing. Pass --base with a ref that the commit is ahead of.`,
    );
  const names = rangeCommits ? Object.keys(rangeChecks) : [];
  const notRun =
    mode === 'current' && !rangeCommits ? Object.keys(rangeChecks) : [];
  return { rangeCommits, ranges: names, notRun };
}

function verify(directory, provenance, install) {
  const expectedNode = readFileSync(
    join(directory, '.node-version'),
    'utf8',
  ).trim();
  if (process.versions.node !== expectedNode)
    throw new Error(`Use Node ${expectedNode}.`);
  if (git(directory, ['ls-files', '--', '.quality-results']))
    throw new Error(
      'Tracked .quality-results files could forge verification records.',
    );
  fixtureConfig(directory);
  const before = fingerprint(directory);
  const results = [];
  if (install)
    results.push(run(directory, 'install', ['ci', '--no-audit', '--no-fund']));
  const names =
    provenance.mode === 'staged'
      ? ['lint', 'format', 'credentials']
      : Object.keys(checks);
  const { rangeCommits, ranges, notRun } = planRanges(directory, provenance);
  if (results.every(result => result.passed)) {
    for (const name of names) results.push(run(directory, name, checks[name]));
    for (const name of ranges)
      results.push(
        run(directory, name, [
          ...rangeChecks[name],
          provenance.base,
          provenance.commit,
        ]),
      );
  }
  let unchanged = false;
  try {
    unchanged = before === fingerprint(directory);
  } catch {
    /* Report a changed source below. */
  }
  const passed =
    unchanged &&
    results.length === names.length + ranges.length + Number(install) &&
    results.every(result => result.passed);
  const report = {
    ...provenance,
    node: process.versions.node,
    required: [...names, ...ranges],
    notRun,
    unchanged,
    passed,
    results,
  };
  writeFileSync(
    join(output, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    `${provenance.mode}: commit ${provenance.commit}, tree ${provenance.tree}${provenance.base ? `, base ${provenance.base} (${rangeCommits} commits)` : ''}; ${passed ? 'PASS' : 'FAIL'}${notRun.length ? ` (range checks not run: ${notRun.join(', ')})` : ''}`,
  );
  if (!passed) process.exitCode = 1;
}

function verifyRef(commit, snapshotMode = 'commit') {
  // The source repository holds the base ref; the snapshot holds only branches.
  const base =
    snapshotMode === 'commit'
      ? [
          '--base',
          mergeBase(identity(root, commit).commit, baseRef ?? 'origin/main'),
        ]
      : [];
  withSnapshot(root, snapshotMode, commit, (directory, provenance) => {
    // Execute the snapshot's checks, not an unstaged copy of the checking code.
    const result = spawnSync(
      process.execPath,
      [
        join(directory, 'tools/verify.cjs'),
        `${snapshotMode}-checkout`,
        join(output, `${snapshotMode}-${provenance.commit}`),
        ...base,
      ],
      {
        cwd: directory,
        env: cleanEnvironment(),
        stdio: 'inherit',
      },
    );
    if (result.status !== 0) process.exitCode = 1;
  });
}

try {
  if (baseFlag !== -1 && !baseRef) throw new Error('Name a ref after --base.');
  if (mode === 'commit' || mode === 'staged') {
    verifyRef(ref, mode);
  } else if (mode === 'commit-checkout' || mode === 'staged-checkout') {
    if (existsSync(join(root, 'node_modules')))
      throw new Error('An isolated check requires a fresh dependency install.');
    const provenance = { mode: mode.split('-')[0], ...identity(root, 'HEAD') };
    if (mode === 'staged-checkout') provenance.tree = git(root, ['write-tree']);
    else if (git(root, ['status', '--porcelain']))
      throw new Error('Commit checkout must be clean.');
    else if (!baseRef)
      throw new Error('Commit checkout needs --base <commit>.');
    else provenance.base = baseRef;
    verify(root, provenance, true);
  } else if (mode === 'current') {
    if (git(root, ['status', '--porcelain']))
      throw new Error('CI checkout must be clean.');
    if (existsSync(join(root, 'node_modules')))
      throw new Error('CI must begin without installed dependencies.');
    const provenance = { mode, ...identity(root, 'HEAD') };
    if (baseRef) provenance.base = mergeBase(provenance.commit, baseRef);
    verify(root, provenance, true);
  } else if (mode === 'push') {
    const refs = readFileSync(0, 'utf8').trim().split('\n');
    const commits = new Set();
    for (const line of refs) {
      const sha = line.split(/\s+/u)[1];
      if (sha && !/^0+$/u.test(sha)) commits.add(sha);
    }
    for (const commit of commits) verifyRef(commit);
  } else {
    throw new Error(
      'Usage: node tools/verify.cjs staged | commit [ref] [--base <ref>] | current [--base <ref>] | push [--base <ref>]',
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
