const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');

const suites = [
  ['tools', '.', 'tools/jest.config.cjs'],
  ['app', 'packages/app', 'jest.config.js'],
  ['server', 'packages/server', 'jest.config.cjs'],
];
function assertComplete(data, name) {
  if (
    !data.success ||
    data.numTotalTests < 1 ||
    data.numPendingTests !== 0 ||
    data.numTodoTests !== 0 ||
    data.numFailedTests !== 0 ||
    data.numFailedTestSuites !== 0 ||
    data.numRuntimeErrorTestSuites !== 0
  )
    throw new Error(
      `${name} tests were missing, skipped, unfinished, or failed.`,
    );
}

function main() {
  const output = mkdtempSync(join(tmpdir(), 'chat-jest-'));
  try {
    for (const [name, directory, config] of suites) {
      const report = join(output, `${name}.json`);
      const result = spawnSync(
        process.execPath,
        [
          '--experimental-vm-modules',
          resolve('node_modules/jest/bin/jest.js'),
          '--config',
          config,
          '--runInBand',
          '--ci',
          '--json',
          '--outputFile',
          report,
        ],
        { cwd: directory, stdio: 'inherit', timeout: 5 * 60 * 1000 },
      );
      if (result.status !== 0)
        throw new Error(`${name} tests failed or did not finish.`);
      const data = JSON.parse(readFileSync(report, 'utf8'));
      assertComplete(data, name);
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

module.exports = { assertComplete };
if (require.main === module) main();
