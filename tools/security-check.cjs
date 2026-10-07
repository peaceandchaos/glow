const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { dirname, join, relative, resolve } = require('node:path');
const { globPattern } = require('./skills/routing.cjs');
const { git } = require('./verification/snapshot.cjs');

const root = resolve(__dirname, '..');
// rnsec 1.3.0 always skips these paths (dist/core/fileWalker.js defaultIgnore).
const scannerSkips = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.expo/**',
  '**/android/build/**',
  '**/ios/build/**',
  '**/.git/**',
  '**/coverage/**',
  '**/*.test.js',
  '**/*.test.ts',
  '**/*.test.jsx',
  '**/*.test.tsx',
  '**/*.spec.js',
  '**/*.spec.ts',
  '**/*.spec.jsx',
  '**/*.spec.tsx',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/e2e/**',
  '**/tests/**',
  '**/test/**',
  '**/*.e2e.js',
  '**/*.e2e.ts',
];
// The app bundle imports source from these folders.
const scanRoots = ['packages/app', 'shared'];
const testFolders = [
  'packages/app/__tests__/',
  'packages/server/tests/',
  'tools/__tests__/',
];
// npm audit advisories are judged by audit:check with dated dispositions.
const dependencyRule = 'NPM_VULNERABLE_DEPENDENCY';
const severities = ['LOW', 'MEDIUM', 'HIGH'];

function scan(path) {
  const cli = join(
    dirname(require.resolve('rnsec/package.json')),
    'dist/index.js',
  );
  const result = spawnSync(
    process.execPath,
    [cli, 'scan', '--path', path, '--json', '--silent'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 5 * 60 * 1000 },
  );
  if (result.error || result.signal || ![0, 1].includes(result.status))
    throw new Error('rnsec did not complete.');
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`rnsec returned no report.\n${result.stderr}`);
  }
  const high = report.findings?.some?.(finding => finding.severity === 'HIGH');
  if (result.status === 1 && !high)
    throw new Error(`rnsec failed without a HIGH finding.\n${result.stderr}`);
  return report;
}

function scanAll(base = root) {
  const reports = scanRoots.map(folder => {
    const report = scan(join(base, folder));
    if (!(report.scannedFiles > 0))
      throw new Error(`rnsec scanned no files in ${folder}.`);
    return report;
  });
  return {
    findings: reports.flatMap(report => report.findings),
    ignoredRules: reports.flatMap(report => report.ignoredRules),
    scannedFiles: reports.reduce((sum, report) => sum + report.scannedFiles, 0),
  };
}

function evaluate(report, dispositions, today, base = root) {
  if (
    !Array.isArray(report.findings) ||
    !Array.isArray(report.ignoredRules) ||
    !(report.scannedFiles > 0)
  ) {
    throw new Error('rnsec report is missing, invalid, or scanned no files.');
  }
  const failures = [];
  if (report.ignoredRules.length)
    failures.push(
      `rnsec ignores ${report.ignoredRules.join(', ')}; record dispositions instead.`,
    );
  const used = new Set();
  for (const finding of report.findings) {
    if (!severities.includes(finding.severity))
      throw new Error(`Unknown rnsec severity for ${finding.ruleId}.`);
    if (finding.ruleId === dependencyRule) continue;
    const key = `${finding.ruleId} ${relative(base, finding.filePath)}:${finding.line}`;
    if (finding.severity === 'HIGH') {
      failures.push(`${key}: HIGH has no exceptions`);
      continue;
    }
    const disposition = dispositions[key];
    used.add(key);
    if (
      !disposition ||
      disposition.severity !== finding.severity ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(disposition.reviewBy) ||
      disposition.reviewBy < today ||
      !disposition.reason
    ) {
      failures.push(`${key}: ${finding.severity} needs a current disposition`);
    }
  }
  for (const key of Object.keys(dispositions)) {
    if (!used.has(key)) failures.push(`${key}: disposition matches no finding`);
  }
  return failures;
}

function scannerGaps(files) {
  const skipped = scannerSkips.map(globPattern);
  return files.filter(
    file =>
      /\.[jt]sx?$/u.test(file) &&
      !testFolders.some(folder => file.startsWith(folder)) &&
      skipped.some(pattern => pattern.test(file)),
  );
}

function main() {
  const gaps = scannerGaps(git(root, ['ls-files']).split('\n'));
  const report = scanAll();
  const dispositions = JSON.parse(
    readFileSync(
      join(__dirname, 'verification/security-dispositions.json'),
      'utf8',
    ),
  );
  const failures = [
    ...gaps.map(
      file => `${file}: rnsec skips this path, so the scan cannot read it.`,
    ),
    ...evaluate(report, dispositions, new Date().toISOString().slice(0, 10)),
  ];
  const deferred = report.findings.filter(
    finding => finding.ruleId === dependencyRule,
  ).length;
  for (const failure of failures) console.error(failure);
  console.log(
    `App security policy: ${failures.length === 0 ? 'PASS' : 'FAIL'}; ${report.scannedFiles} files, ${report.findings.length} findings, ${deferred} dependency advisories judged by audit:check.`,
  );
  if (failures.length) process.exitCode = 1;
}

module.exports = { scan, scanAll, evaluate, scannerSkips, scannerGaps };
if (require.main === module) main();
