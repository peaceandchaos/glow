const { inspectFile } = require('../check-credentials.cjs');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

test.each([
  ['.env', 'PORT=3000', 'secret file'],
  [
    'src/config.ts',
    `export const token = 'sk-proj-${'a'.repeat(40)}';`,
    'OpenAI key',
  ],
  ['keys.txt', ['-----BEGIN', 'PRIVATE KEY-----'].join(' '), 'private key'],
  [
    'config.ts',
    `export const AI_GATEWAY_API_KEY = '${'a'.repeat(30)}';`,
    'embedded credential',
  ],
  [
    'packages/server/src/services.ts',
    `const ALLOWED_APPLE_USER_IDS = '${'0'.repeat(6)}.${'a'.repeat(32)}.${'0'.repeat(4)}';`,
    'embedded credential',
  ],
  [
    'packages/app/ios/MargeloChat.xcodeproj/project.pbxproj',
    '\t\t\t\tDEVELOPMENT_TEAM = ABCDE12345;',
    'Apple team ID',
  ],
])('rejects %s containing %s', (path, content, expected) => {
  expect(inspectFile(path, content)).toContain(expected);
});

test.each([
  ['.env.example', 'AI_GATEWAY_API_KEY='],
  ['config.example.ts', "export const OPENAI_API_KEY = 'sk-proj-...';"],
  ['server.ts', 'const key = process.env.AI_GATEWAY_API_KEY;'],
  ['packages/app/ios/Glow.xcconfig', '#include? "DevelopmentTeam.xcconfig"'],
  ['README.md', 'put `DEVELOPMENT_TEAM = <team ID>` in the ignored file'],
])('allows non-secret configuration in %s', (path, content) => {
  expect(inspectFile(path, content)).toEqual([]);
});

test('checks staged content and does not print credential values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'credential-hook-'));
  const secret = `sk-proj-${'b'.repeat(40)}`;
  try {
    execFileSync('git', ['init', '--quiet', directory]);
    writeFileSync(join(directory, 'config.ts'), `const key = '${secret}';`);
    execFileSync('git', ['add', 'config.ts'], { cwd: directory });
    writeFileSync(join(directory, 'config.ts'), 'const key = process.env.KEY;');
    const result = spawnSync(
      process.execPath,
      [resolve(__dirname, '../check-credentials.cjs'), '--staged'],
      { cwd: directory, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('config.ts: OpenAI key');
    expect(result.stderr).not.toContain(secret);
    expect(result.stdout).not.toContain(secret);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
