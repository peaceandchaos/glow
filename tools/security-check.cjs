const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { dirname, join, relative, resolve } = require('node:path');

const root = resolve(__dirname, '..');
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

function main() {
  const report = scan(join(root, 'packages/app'));
  const dispositions = JSON.parse(
    readFileSync(
      join(__dirname, 'verification/security-dispositions.json'),
      'utf8',
    ),
  );
  const failures = evaluate(
    report,
    dispositions,
    new Date().toISOString().slice(0, 10),
  );
  const deferred = report.findings.filter(
    finding => finding.ruleId === dependencyRule,
  ).length;
  for (const failure of failures) console.error(failure);
  console.log(
    `App security policy: ${failures.length === 0 ? 'PASS' : 'FAIL'}; ${report.scannedFiles} files, ${report.findings.length} findings, ${deferred} dependency advisories judged by audit:check.`,
  );
  if (failures.length) process.exitCode = 1;
}

module.exports = { scan, evaluate };
if (require.main === module) main();
