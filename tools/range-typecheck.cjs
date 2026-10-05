const { execFileSync, spawnSync } = require('node:child_process');
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { git } = require('./verification/snapshot.cjs');

// npm ci reads these files, so commits that share them share an install.
const installInput =
  /\t(?:\.npmrc|package(?:-lock)?\.json|packages\/[^/]+\/package\.json|packages\/app\/patches\/.+)$/u;
const config = 'packages/app/src/config.ts';

function installKey(root, commit) {
  return git(root, ['ls-tree', '-r', commit])
    .split('\n')
    .filter(line => installInput.test(line))
    .join('\n');
}

function nodeModules(directory) {
  const workspaces = readdirSync(join(directory, 'packages')).map(
    name => `packages/${name}/node_modules`,
  );
  return ['node_modules', ...workspaces].filter(path =>
    existsSync(join(directory, path)),
  );
}

function extract(root, commit, directory) {
  const archive = execFileSync('git', ['archive', '--format=tar', commit], {
    cwd: root,
    maxBuffer: 512 * 1024 * 1024,
  });
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  copyFileSync(
    join(directory, 'packages/app/src/config.example.ts'),
    join(directory, config),
  );
}

function npm(directory, args) {
  return spawnSync('npm', args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function checkRange(root, base, head) {
  // root has HEAD installed, and the types check covers HEAD.
  const installed = git(root, ['rev-parse', 'HEAD']);
  const commits = git(root, ['rev-list', '--reverse', `${base}..${head}`])
    .split('\n')
    .filter(commit => commit && commit !== installed);
  const installs = new Map([[installKey(root, installed), root]]);
  const scratch = mkdtempSync(join(tmpdir(), 'range-typecheck-'));
  const lines = [];
  let failed = false;
  try {
    for (const commit of commits) {
      const directory = join(scratch, commit);
      mkdirSync(directory);
      extract(root, commit, directory);
      const key = installKey(root, commit);
      let install = 'shared install';
      if (installs.has(key)) {
        const source = installs.get(key);
        for (const path of nodeModules(source))
          symlinkSync(join(source, path), join(directory, path));
      } else {
        install = 'own install';
        const result = npm(directory, ['ci', '--no-audit', '--no-fund']);
        if (result.status !== 0) {
          lines.push(
            `${commit.slice(0, 12)} ${subject(root, commit)}: install FAIL`,
            result.stdout + result.stderr,
          );
          failed = true;
          continue;
        }
        installs.set(key, directory);
      }
      const typed = npm(directory, ['run', 'typecheck']);
      const passed = typed.status === 0;
      failed ||= !passed;
      lines.push(
        `${commit.slice(0, 12)} ${subject(root, commit)}: ${passed ? 'PASS' : 'FAIL'} (${install})`,
      );
      if (!passed) lines.push(typed.stdout + typed.stderr);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { commits: commits.length, failed, lines };
}

function subject(root, commit) {
  return git(root, ['log', '-1', '--format=%s', commit]);
}

function main([baseRef, headRef = 'HEAD']) {
  if (!baseRef)
    throw new Error('Usage: npm run typecheck:range -- <base> [<head>]');
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  const head = git(root, ['rev-parse', '--verify', `${headRef}^{commit}`]);
  const base = git(root, ['merge-base', baseRef, head]);
  const result = checkRange(root, base, head);
  console.log(
    [
      `Typecheck of ${result.commits} commits other than HEAD in ${base.slice(0, 12)}..${head.slice(0, 12)}:`,
      ...result.lines,
    ].join('\n'),
  );
  if (result.failed) process.exitCode = 1;
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
