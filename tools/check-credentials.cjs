const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const signatures = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ['OpenAI key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/u],
  ['Pinecone key', /\bpcsk_[A-Za-z0-9_-]{24,}\b/u],
  [
    'GitHub token',
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/u,
  ],
  ['AWS access key', /\bAKIA[A-Z0-9]{16}\b/u],
  ['Apple team ID', /\bDEVELOPMENT_TEAM\s*=\s*"?[A-Z0-9]{10}\b/u],
  [
    'embedded credential',
    /\b(?:OPENAI_API_KEY|AI_GATEWAY_API_KEY|PINECONE_API_KEY|ALLOWED_APPLE_USER_IDS|DEVICE_ID)\b\s*[:=]\s*['"][A-Za-z0-9_,.-]{24,}['"]/u,
  ],
];

function inspectFile(path, content) {
  const example = /(?:^|[./_-])(?:example|sample|template)(?:[./_-]|$)/u.test(
    path,
  );
  const secretFile =
    /(?:^|\/)(?:\.env(?:\..*)?|credentials\.json|service-account[^/]*\.json)$|\.(?:p12|pfx|key)$/u.test(
      path,
    );
  const findings = [];
  if (secretFile && !example) findings.push('secret file');
  for (const [name, pattern] of signatures) {
    if (pattern.test(content)) findings.push(name);
  }
  return findings;
}

function checkRepository(staged) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const args = staged
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
    : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  const paths = execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  let count = 0;
  for (const path of paths) {
    if (!staged && !existsSync(resolve(root, path))) continue;
    const content = staged
      ? execFileSync('git', ['show', `:${path}`], {
          cwd: root,
          maxBuffer: 16 * 1024 * 1024,
        }).toString('utf8')
      : readFileSync(resolve(root, path), 'utf8');
    for (const finding of inspectFile(path, content)) {
      console.error(`${path}: ${finding}`);
      count++;
    }
  }
  if (count > 0) process.exitCode = 1;
  else
    console.log(
      `Credential check passed (${staged ? 'staged' : 'tracked'} files).`,
    );
}

module.exports = { inspectFile };
if (require.main === module) checkRepository(process.argv.includes('--staged'));
