const { execFileSync } = require('node:child_process');
const {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  readlinkSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { createHash } = require('node:crypto');

function cleanEnvironment() {
  const env = { ...process.env, HUSKY: '0' };
  // Hooks supply index/worktree variables. Never let them point at the caller.
  // `npm run` exports the caller's npm settings, such as ignore-scripts.
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('GIT_') ||
      /^npm_config_/iu.test(key) ||
      /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|DATABASE_URL|DEVICE_IDS?/u.test(
        key,
      )
    )
      delete env[key];
  }
  return env;
}

function git(directory, args) {
  return execFileSync('git', args, {
    cwd: directory,
    env: cleanEnvironment(),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function identity(directory, ref) {
  const commit = git(directory, ['rev-parse', '--verify', `${ref}^{commit}`]);
  return { commit, tree: git(directory, ['rev-parse', `${commit}^{tree}`]) };
}

function stagedTree(directory) {
  const env = cleanEnvironment();
  // A path-limited commit can use a temporary index. Honor it only at the source.
  if (process.env.GIT_INDEX_FILE) {
    env.GIT_INDEX_FILE = resolve(directory, process.env.GIT_INDEX_FILE);
  }
  return execFileSync('git', ['write-tree'], {
    cwd: directory,
    env,
    encoding: 'utf8',
  }).trim();
}

function withSnapshot(source, mode, ref, action) {
  const base = identity(source, ref);
  const tree = mode === 'staged' ? stagedTree(source) : base.tree;
  const directory = mkdtempSync(join(tmpdir(), 'chat-verification-'));
  const checkout = join(directory, 'checkout');
  try {
    git(source, [
      'clone',
      '--quiet',
      '--no-checkout',
      '--no-hardlinks',
      source,
      checkout,
    ]);
    git(checkout, ['config', 'core.hooksPath', '/dev/null']);
    git(checkout, ['config', 'core.autocrlf', 'false']);
    git(checkout, ['checkout', '--quiet', '--detach', base.commit]);
    if (mode === 'staged') git(checkout, ['read-tree', '--reset', '-u', tree]);
    return action(checkout, { mode, commit: base.commit, tree });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const generated = new Set([
  '.git',
  '.quality-results',
  'rnsec-report.json',
  'rnsec-report.html',
  'packages/server/.nitro',
  'packages/server/.output',
  'packages/server/.vercel',
  'packages/server/.workflow-data',
  // Workflow's server build creates this compiled SWC plugin cache.
  'packages/server/.swc',
]);

function hashSource(directory, relative, hash) {
  const entries = readdirSync(join(directory, relative), {
    withFileTypes: true,
  });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.name === 'node_modules' || generated.has(path)) continue;
    hash.update(path);
    if (entry.isDirectory()) hashSource(directory, path, hash);
    else if (entry.isSymbolicLink())
      hash.update(readlinkSync(join(directory, path)));
    else hash.update(readFileSync(join(directory, path)));
  }
}

function fingerprint(directory) {
  git(directory, ['diff', '--quiet']);
  const hash = createHash('sha256');
  hash.update(git(directory, ['write-tree']));
  hashSource(directory, '', hash);
  return hash.digest('hex');
}

module.exports = { git, identity, withSnapshot, fingerprint, cleanEnvironment };
