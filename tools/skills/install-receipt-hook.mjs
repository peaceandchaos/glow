// Installs the skill receipt hook into Claude Code user settings.
// It prints the plan and changes nothing unless it gets --apply.
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage =
  'Usage: node tools/skills/install-receipt-hook.mjs [--apply] [--remove-spike]';
const hookName = 'skill-receipt-hook.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../..');

function paths(home) {
  const claude = join(home, '.claude');
  const state = join(claude, 'skill-receipts');
  return {
    claude,
    hook: join(claude, 'hooks', hookName),
    roots: join(claude, 'hooks', 'skill-receipt-roots.json'),
    state,
    key: join(state, 'private-key.pem'),
    settings: join(claude, 'settings.json'),
  };
}

// In user settings, a rule path that starts with / is rooted at ~/.claude.
const denyRules = [
  'Read(/hooks/**)',
  'Edit(/hooks/**)',
  'Read(/skill-receipts/private-key.pem)',
  'Edit(/skill-receipts/**)',
  'Bash(*.claude/hooks*)',
  'Bash(*skill-receipt-hook*)',
  'Bash(*skill-receipts*)',
  'Bash(*private-key.pem*)',
];

const expandHome = (path, home) =>
  path === '~' || path.startsWith('~/') ? join(home, path.slice(2)) : path;

// Plugin skills load as <plugin>:<skill>. Each plugin root in routing.json is
// named for its plugin.
function rootsConfig(home, env) {
  const routing = JSON.parse(
    readFileSync(join(repository, 'tools/skills/routing.json'), 'utf8'),
  );
  const config = { plugins: {}, user: null, repo: [] };
  const unset = [];
  for (const [name, root] of Object.entries(routing.roots)) {
    const value = env[root.env] ?? root.default;
    if (name === 'repo') config.repo.push(value);
    else if (!value) unset.push(root.env);
    else if (name === 'user') config.user = resolve(expandHome(value, home));
    else config.plugins[name] = resolve(expandHome(value, home));
  }
  return { config, unset };
}

function command(hook) {
  return `"${process.execPath}" "${hook}"`;
}

const ours = entry => JSON.stringify(entry).includes(hookName);

function plannedSettings(before, hook, removeSpike) {
  const after = structuredClone(before);
  after.hooks ??= {};
  const entries = after.hooks.PostToolUse ?? [];
  const entry = {
    matcher: 'Skill|Read',
    hooks: [{ type: 'command', command: command(hook), timeout: 5 }],
  };
  const spikes = entries.filter(
    candidate => candidate.matcher === 'Skill|Read' && !ours(candidate),
  );
  const kept = entries.filter(
    candidate =>
      !ours(candidate) && !(removeSpike && spikes.includes(candidate)),
  );
  after.hooks.PostToolUse = [...kept, entry];
  after.permissions ??= {};
  const deny = after.permissions.deny ?? [];
  const added = denyRules.filter(rule => !deny.includes(rule));
  after.permissions.deny = [...deny, ...added];
  const same = candidate => JSON.stringify(candidate) === JSON.stringify(entry);
  const removed = entries.filter(candidate => !kept.includes(candidate));
  const changes = [
    ...removed
      .filter(candidate => !same(candidate))
      .map(candidate => `- hooks.PostToolUse ${JSON.stringify(candidate)}`),
    ...(removed.some(same)
      ? []
      : [`+ hooks.PostToolUse ${JSON.stringify(entry)}`]),
    ...added.map(rule => `+ permissions.deny ${JSON.stringify(rule)}`),
  ];
  return { after, spikes, changes };
}

function readSettings(file) {
  if (!existsSync(file)) return { text: '', settings: {} };
  const text = readFileSync(file, 'utf8');
  return { text, settings: JSON.parse(text) };
}

function fileStep(target, content, show) {
  const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (current === content) return null;
  return {
    say: `${current === null ? 'Create' : 'Update'} ${target}${show ? `:\n${content.trimEnd()}` : '.'}`,
    run: () => {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    },
  };
}

function plan(home, env, flags) {
  const where = paths(home);
  const steps = [];
  const notes = [];
  const hookStep = fileStep(
    where.hook,
    readFileSync(join(here, 'receipt-hook.mjs'), 'utf8'),
  );
  if (hookStep) steps.push(hookStep);
  const { config, unset } = rootsConfig(home, env);
  for (const variable of unset)
    notes.push(
      `${variable} is unset, so the hook cannot resolve that root's skills. Set it and run this again.`,
    );
  const rootsStep = fileStep(
    where.roots,
    `${JSON.stringify(config, null, 2)}\n`,
    true,
  );
  if (rootsStep) steps.push(rootsStep);
  if (!existsSync(where.key))
    steps.push({
      say: `Generate an Ed25519 keypair. Write the private key to ${where.key} with mode 0600.`,
      run: () => {
        const { privateKey } = generateKeyPairSync('ed25519');
        mkdirSync(where.state, { recursive: true, mode: 0o700 });
        writeFileSync(
          where.key,
          privateKey.export({ type: 'pkcs8', format: 'pem' }),
          { flag: 'wx', mode: 0o600 },
        );
      },
    });
  else notes.push(`Keep the existing key at ${where.key}.`);
  const { text, settings } = readSettings(where.settings);
  const { after, spikes, changes } = plannedSettings(
    settings,
    where.hook,
    flags.removeSpike,
  );
  if (spikes.length && !flags.removeSpike)
    notes.push(
      `Leave ${spikes.length} other Skill|Read PostToolUse ${spikes.length === 1 ? 'entry' : 'entries'} in place. Pass --remove-spike to remove ${spikes.length === 1 ? 'it' : 'them'}.`,
    );
  if (changes.length) {
    const afterText = `${JSON.stringify(after, null, 2)}\n`;
    const backup = `${where.settings}.backup-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
    if (text)
      steps.push({
        say: `Back up ${where.settings} to ${backup}.`,
        run: () => copyFileSync(where.settings, backup),
      });
    steps.push({
      say: `${text ? 'Update' : 'Create'} ${where.settings}:\n${changes.map(change => `  ${change}`).join('\n')}`,
      run: () => {
        mkdirSync(dirname(where.settings), { recursive: true });
        writeFileSync(`${where.settings}.tmp`, afterText);
        renameSync(`${where.settings}.tmp`, where.settings);
      },
    });
  }
  return { where, steps, notes };
}

function publicKey(key) {
  return createPublicKey(createPrivateKey(readFileSync(key, 'utf8'))).export({
    type: 'spki',
    format: 'pem',
  });
}

function main(args) {
  const flags = {
    apply: args.includes('--apply'),
    removeSpike: args.includes('--remove-spike'),
  };
  if (args.some(arg => arg !== '--apply' && arg !== '--remove-spike'))
    throw new Error(usage);
  const { where, steps, notes } = plan(homedir(), process.env, flags);
  const lines = [
    `${flags.apply ? 'Applying' : 'Planned'} changes for ${where.claude}:`,
    ...(steps.length ? steps.map(step => `- ${step.say}`) : ['- None.']),
    ...notes.map(note => `Note: ${note}`),
  ];
  if (!flags.apply) {
    lines.push('Dry run. Nothing was written. Run again with --apply.');
    console.log(lines.join('\n'));
    return;
  }
  for (const step of steps) step.run();
  lines.push(
    '',
    'Commit this public key as tools/skills/receipt-public-key.pem:',
    publicKey(where.key).trimEnd(),
  );
  console.log(lines.join('\n'));
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
