// Prints the ruleset the owner applies. The bootstrap stage omits target-health
// because the default branch has no trusted controller until the baseline merges.
const rules = require('./integration-rules.json');

function ruleset(stage) {
  if (stage === 'full') return rules;
  if (stage !== 'bootstrap') throw new Error('Use bootstrap or full.');
  const bootstrap = structuredClone(rules);
  const checks = bootstrap.rules.find(
    rule => rule.type === 'required_status_checks',
  ).parameters;
  checks.required_status_checks = checks.required_status_checks.filter(
    check => check.context !== 'target-health',
  );
  return bootstrap;
}

module.exports = ruleset;
if (require.main === module)
  console.log(JSON.stringify(ruleset(process.argv[2]), null, 2));
