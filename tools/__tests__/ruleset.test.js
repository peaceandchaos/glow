const ruleset = require('../github/ruleset.cjs');

test('the bootstrap ruleset differs from the full ruleset only by target-health', () => {
  const full = ruleset('full');
  const bootstrap = ruleset('bootstrap');
  const checks = stage =>
    stage.rules.find(rule => rule.type === 'required_status_checks').parameters
      .required_status_checks;
  expect(full.rules.map(rule => rule.type)).toEqual([
    'creation',
    'deletion',
    'non_fast_forward',
    'required_linear_history',
    'pull_request',
    'required_status_checks',
  ]);
  expect(checks(full)).toEqual([
    { context: 'quality-gate', integration_id: 15368 },
    { context: 'target-health', integration_id: 15368 },
  ]);
  expect(checks(bootstrap)).toEqual([
    { context: 'quality-gate', integration_id: 15368 },
  ]);
  const withoutChecks = stage => ({
    ...stage,
    rules: stage.rules.filter(rule => rule.type !== 'required_status_checks'),
  });
  expect(withoutChecks(bootstrap)).toEqual(withoutChecks(full));
  expect(bootstrap.bypass_actors).toEqual([]);
  expect(bootstrap.conditions.ref_name).toEqual({
    include: ['~ALL'],
    exclude: ['refs/heads/submission/**/*'],
  });
  expect(() => ruleset('none')).toThrow('Use bootstrap or full.');
});
