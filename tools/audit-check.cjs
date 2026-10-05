const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const severities = ['low', 'moderate', 'high', 'critical'];
const serious = ['high', 'critical'];
const unpatchedDays = 14;

function isDate(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}

function hasReason(disposition) {
  return (
    typeof disposition.reason === 'string' && disposition.reason.trim() !== ''
  );
}

function addDays(day, days) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function npmView(args) {
  const result = spawnSync('npm', ['view', ...args, '--json'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error || result.signal || result.status !== 0)
    throw new Error(`npm view ${args.join(' ')} did not complete.`);
  return JSON.parse(result.stdout);
}

const npmRegistry = {
  latest: name => npmView([name, 'version']),
  // A release outside the vulnerable range counts as a fix, even an older one.
  // npm view leaves prereleases out of a range that names none, so a package
  // with a prerelease inside the range always counts as fixed.
  unfixed(name, range) {
    const affected = [].concat(npmView([`${name}@${range}`, 'version']));
    return []
      .concat(npmView([name, 'versions']))
      .every(version => affected.includes(version));
  },
};

function assertAudit(audit) {
  if (
    audit.error ||
    audit.auditReportVersion !== 2 ||
    !audit.vulnerabilities ||
    !audit.metadata?.dependencies
  ) {
    throw new Error('Audit response is missing or invalid.');
  }
  for (const [name, finding] of Object.entries(audit.vulnerabilities)) {
    if (!severities.includes(finding.severity)) {
      throw new Error(`Unknown advisory severity for ${name}.`);
    }
    for (const advisory of finding.via)
      if (
        typeof advisory !== 'string' &&
        !severities.includes(advisory.severity)
      )
        throw new Error(`Unknown advisory severity in ${name}.`);
  }
}

const keyOf = advisory => `${advisory.url} ${advisory.name}`;

function seriousAdvisories(vulnerabilities) {
  const advisories = new Map();
  for (const finding of Object.values(vulnerabilities))
    for (const advisory of finding.via)
      if (typeof advisory !== 'string' && serious.includes(advisory.severity))
        advisories.set(keyOf(advisory), [
          ...(advisories.get(keyOf(advisory)) ?? []),
          advisory,
        ]);
  return advisories;
}

function inWindow(disposition, today) {
  return (
    isDate(disposition.reviewedAt) &&
    isDate(disposition.reviewBy) &&
    disposition.reviewedAt <= today &&
    disposition.reviewBy >= today &&
    disposition.reviewBy <= addDays(disposition.reviewedAt, unpatchedDays)
  );
}

function unpatchedProblem(advisory, disposition, today, registry) {
  if (disposition?.decision !== 'track-unpatched')
    return 'has no track-unpatched disposition';
  if (advisory.severity !== 'high')
    return `is ${advisory.severity}, and only a high advisory can be tracked unpatched`;
  if (
    disposition.package !== advisory.name ||
    disposition.range !== advisory.range ||
    disposition.severity !== advisory.severity
  )
    return 'has a track-unpatched disposition for another package, range or severity';
  if (!inWindow(disposition, today))
    return `needs a reviewedAt date no later than today, and a reviewBy date from today to ${unpatchedDays} days after reviewedAt`;
  if (!hasReason(disposition)) return 'needs a reason';
  if (typeof disposition.latest !== 'string' || !disposition.latest)
    return 'needs the latest release';
  const latest = registry.latest(advisory.name);
  if (latest !== disposition.latest)
    return `may be fixed, because ${advisory.name} ${latest} is released`;
  if (!registry.unfixed(advisory.name, advisory.range))
    return `may be fixed, because ${advisory.name} has a release outside ${advisory.range}`;
  return null;
}

// A name the audit doesn't list yields a key that nothing excuses, so the
// package stays blocked.
function reached(vulnerabilities, name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const finding = vulnerabilities[name];
  if (!finding) return [`missing ${name}`];
  return finding.via.flatMap(entry =>
    typeof entry === 'string'
      ? reached(vulnerabilities, entry, seen)
      : serious.includes(entry.severity)
        ? [keyOf(entry)]
        : [],
  );
}

function covered(vulnerabilities, name, excused) {
  const keys = reached(vulnerabilities, name);
  return keys.length > 0 && keys.every(key => excused.has(key));
}

function needsReview(advisory, disposition, today) {
  return (
    !disposition ||
    disposition.range !== advisory.range ||
    disposition.decision !== 'track' ||
    !isDate(disposition.reviewBy) ||
    disposition.reviewBy < today ||
    !hasReason(disposition)
  );
}

function evaluate(audit, dispositions, today, registry = npmRegistry) {
  assertAudit(audit);
  const failures = new Set();
  const advisories = seriousAdvisories(audit.vulnerabilities);
  const excused = new Set();
  for (const [key, instances] of advisories) {
    const problems = instances.flatMap(advisory => {
      const problem = unpatchedProblem(
        advisory,
        dispositions[advisory.url],
        today,
        registry,
      );
      return problem ? [`${advisory.name}: ${advisory.url} ${problem}`] : [];
    });
    for (const problem of problems) failures.add(problem);
    if (problems.length === 0) excused.add(key);
  }
  for (const [name, finding] of Object.entries(audit.vulnerabilities)) {
    if (
      finding.severity === 'critical' ||
      (finding.severity === 'high' &&
        !covered(audit.vulnerabilities, name, excused))
    )
      failures.add(`${name}: ${finding.severity}`);
    for (const advisory of finding.via) {
      if (typeof advisory === 'string') continue;
      if (serious.includes(advisory.severity)) continue;
      if (needsReview(advisory, dispositions[advisory.url], today))
        failures.add(`${name}: needs current review (${advisory.url})`);
    }
  }
  const seen = new Set(
    [...advisories.values()].flat().map(advisory => advisory.url),
  );
  for (const [url, disposition] of Object.entries(dispositions))
    if (disposition.decision === 'track-unpatched' && !seen.has(url))
      failures.add(
        `${url}: track-unpatched disposition matches no high advisory`,
      );
  return [...failures];
}

function main() {
  const result = spawnSync('npm', ['audit', '--json', '--package-lock-only'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error || result.signal || ![0, 1].includes(result.status))
    throw new Error('npm audit did not complete.');
  const audit = JSON.parse(result.stdout);
  const dispositions = JSON.parse(
    readFileSync(
      join(__dirname, 'verification/dependency-dispositions.json'),
      'utf8',
    ),
  );
  const failures = evaluate(
    audit,
    dispositions,
    new Date().toISOString().slice(0, 10),
  );
  const tracked = Object.values(dispositions).filter(
    disposition => disposition.decision === 'track-unpatched',
  ).length;
  for (const failure of failures) console.error(failure);
  console.log(
    `Dependency policy: ${failures.length === 0 ? 'PASS' : 'FAIL'}; high and critical findings block, except ${tracked} tracked unpatched high ${tracked === 1 ? 'advisory' : 'advisories'}.`,
  );
  if (failures.length) process.exitCode = 1;
}

module.exports = { evaluate };
if (require.main === module) main();
