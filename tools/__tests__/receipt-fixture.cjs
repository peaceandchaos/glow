const { spawnSync } = require('node:child_process');
const { createPrivateKey, generateKeyPairSync, sign } = require('node:crypto');
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { canonical } = require('../skills/receipts.cjs');

const hookSource = resolve(__dirname, '../skills/receipt-hook.mjs');

function makeKey(path) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return publicKey.export({ type: 'spki', format: 'pem' });
}

function installHook(directory, roots) {
  const hook = join(directory, 'skill-receipt-hook.mjs');
  mkdirSync(directory, { recursive: true });
  copyFileSync(hookSource, hook);
  writeFileSync(
    join(directory, 'skill-receipt-roots.json'),
    JSON.stringify(roots),
  );
  return hook;
}

function receiptsIn(state) {
  const file = join(state, 'receipts.jsonl');
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    : [];
}

function runHook(hook, payload, env) {
  return spawnSync(process.execPath, [hook], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function signReceipt(hook, payload, env) {
  const before = receiptsIn(env.SKILL_RECEIPTS_DIR).length;
  const result = runHook(hook, payload, env);
  const after = receiptsIn(env.SKILL_RECEIPTS_DIR);
  if (result.status !== 0 || result.stdout || after.length !== before + 1)
    throw new Error(
      `The hook appended ${after.length - before} receipts (exit ${result.status}).`,
    );
  return after.at(-1);
}

// Signs a copy of a hook receipt with `changes` applied. An undefined value
// drops the field, so a v: 2 receipt can stand in for one from an older hook.
function resign(receipt, changes, keyPath) {
  const { sig, ...fields } = Object.fromEntries(
    Object.entries({ ...receipt, ...changes }).filter(
      ([, value]) => value !== undefined,
    ),
  );
  const key = createPrivateKey(readFileSync(keyPath, 'utf8'));
  return {
    ...fields,
    sig: sign(null, Buffer.from(canonical(fields)), key).toString('base64'),
  };
}

let calls = 0;

function skillPayload(skill, cwd, extra = {}) {
  calls += 1;
  return {
    session_id: 'session-author',
    prompt_id: 'prompt-1',
    transcript_path: '/transcripts/session-author.jsonl',
    cwd,
    scratchpad_dir: '/scratch',
    permission_mode: 'auto',
    effort: 'high',
    hook_event_name: 'PostToolUse',
    tool_name: 'Skill',
    tool_input: { skill },
    tool_use_id: `toolu-${calls}`,
    tool_response: { success: true, commandName: skill },
    duration_ms: 4,
    ...extra,
  };
}

module.exports = {
  installHook,
  makeKey,
  receiptsIn,
  resign,
  runHook,
  signReceipt,
  skillPayload,
};
