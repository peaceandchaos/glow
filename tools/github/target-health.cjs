// This controller reads GitHub metadata only. It never executes candidate code.
const controllerPath = '.github/workflows/target-health.yml';
const ownerLogin = 'peaceandchaos';
const ciContract = {
  workflow: 'ci.yml',
  verifyJob: 'verify (commit)',
  gateJob: 'post-push-gate',
  verifySteps: ['Verify committed source', 'Upload results'],
};

function requiredJobsPassed(jobs) {
  const verification = jobs.find(job => job.name === ciContract.verifyJob);
  const gate = jobs.find(job => job.name === ciContract.gateJob);
  if (verification?.conclusion !== 'success' || gate?.conclusion !== 'success')
    return false;
  return ciContract.verifySteps.every(name =>
    verification.steps.some(
      step => step.name === name && step.conclusion === 'success',
    ),
  );
}

async function targetState(github, repo, branch) {
  const target = await github.rest.git.getRef({
    ...repo,
    ref: `heads/${branch}`,
  });
  const sha = target.data.object.sha;
  const response = await github.rest.actions.listWorkflowRuns({
    ...repo,
    workflow_id: ciContract.workflow,
    branch,
    event: 'push',
    head_sha: sha,
    per_page: 1,
  });
  const run = response.data.workflow_runs[0];
  if (
    !run ||
    run.event !== 'push' ||
    run.head_sha !== sha ||
    run.head_branch !== branch ||
    run.status !== 'completed'
  )
    return { sha, passed: false };
  if (run.conclusion === 'success') {
    const jobs = await github.paginate(
      github.rest.actions.listJobsForWorkflowRun,
      { ...repo, run_id: run.id, filter: 'latest', per_page: 100 },
    );
    if (requiredJobsPassed(jobs)) return { sha, passed: true };
  }
  // A cancelled run proves nothing about the target; rerun it instead of repairing.
  if (run.conclusion === 'cancelled') return { sha, passed: false };
  const validIdentity =
    Number.isSafeInteger(run.id) &&
    run.id > 0 &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0;
  return {
    sha,
    passed: false,
    repairRun: validIdentity ? `${run.id}:${run.run_attempt}` : null,
  };
}

async function approveRepair(github, context) {
  const inputs = context.payload.inputs;
  if (
    context.actor !== ownerLogin ||
    context.ref !== `refs/heads/${context.payload.repository.default_branch}`
  )
    throw new Error(
      'Only the owner may authorize a repair from the default branch.',
    );
  if (
    !/^[1-9]\d*$/u.test(inputs.pr) ||
    !/^[a-f0-9]{40}$/u.test(inputs.head) ||
    !/^[a-f0-9]{40}$/u.test(inputs.base)
  )
    throw new Error('Provide the exact PR, head SHA, and target SHA.');
  const dispatch = (
    await github.rest.actions.getWorkflowRun({
      ...context.repo,
      run_id: context.runId,
    })
  ).data;
  // A rerun would bind whatever target attempt exists now, which the owner never inspected.
  if (dispatch.run_attempt !== 1)
    throw new Error('Repair approval requires a fresh owner dispatch.');
  const pr = (
    await github.rest.pulls.get({
      ...context.repo,
      pull_number: Number(inputs.pr),
    })
  ).data;
  if (pr.state !== 'open' || pr.head.sha !== inputs.head)
    throw new Error('Repair identities changed; nothing was approved.');
  const target = await targetState(github, context.repo, pr.base.ref);
  if (target.sha !== inputs.base)
    throw new Error('Repair identities changed; nothing was approved.');
  if (!target.repairRun)
    throw new Error(
      'Target has no exact completed push run that failed verification.',
    );
  await github.rest.checks.create({
    ...context.repo,
    name: 'owner-repair-approval',
    head_sha: inputs.head,
    // GitHub rewrites details_url for Actions check runs, so the approving run id lives here.
    external_id: `${pr.number}:${inputs.head}:${inputs.base}:${target.repairRun}:${context.runId}`,
    status: 'completed',
    conclusion: 'success',
    output: {
      title: 'Owner authorized target-health repair exception',
      summary:
        'This binds one PR, candidate SHA, target SHA, and failed target run attempt. All candidate checks and reviews remain required.',
    },
  });
}

async function repairAllowed(github, context, pr, target) {
  if (!target.repairRun) return false;
  const approvals = await github.paginate(github.rest.checks.listForRef, {
    ...context.repo,
    ref: pr.head.sha,
    check_name: 'owner-repair-approval',
    filter: 'all',
    per_page: 100,
  });
  const binding = `${pr.number}:${pr.head.sha}:${target.sha}:${target.repairRun}:`;
  for (const approval of approvals) {
    if (
      approval.app?.slug !== 'github-actions' ||
      approval.conclusion !== 'success' ||
      !approval.external_id?.startsWith(binding)
    )
      continue;
    const runId = approval.external_id.slice(binding.length);
    if (!/^[1-9]\d*$/u.test(runId)) continue;
    const run = (
      await github.rest.actions.getWorkflowRun({
        ...context.repo,
        run_id: Number(runId),
      })
    ).data;
    // run-name records the dispatch inputs, so a check cannot borrow an unrelated owner run.
    if (
      run.event === 'workflow_dispatch' &&
      run.run_attempt === 1 &&
      run.display_title ===
        `approve-repair ${pr.number} ${pr.head.sha} ${target.sha}` &&
      (run.conclusion === 'success' || run.id === context.runId) &&
      run.path.split('@')[0] === controllerPath &&
      run.actor.login === ownerLogin &&
      run.triggering_actor.login === ownerLogin &&
      run.head_branch === context.payload.repository.default_branch
    )
      return true;
  }
  return false;
}

async function status(github, repo, sha, state, description) {
  await github.rest.repos.createCommitStatus({
    ...repo,
    sha,
    context: 'target-health',
    state,
    description,
  });
}

async function groupHealthy(github, context, pulls, inspectionTargets) {
  for (const pr of pulls) {
    if (pr.base.ref.startsWith('submission/')) return false;
    if (!inspectionTargets.has(pr.base.ref))
      inspectionTargets.set(
        pr.base.ref,
        await targetState(github, context.repo, pr.base.ref),
      );
    const target = inspectionTargets.get(pr.base.ref);
    if (!target.passed && !(await repairAllowed(github, context, pr, target)))
      return false;
  }
  // Results are SHA-scoped. Check every PR sharing a head, then recheck identities.
  for (const pr of pulls) {
    const current = (
      await github.rest.pulls.get({ ...context.repo, pull_number: pr.number })
    ).data;
    const target = await github.rest.git.getRef({
      ...context.repo,
      ref: `heads/${pr.base.ref}`,
    });
    if (
      current.state !== 'open' ||
      current.head.sha !== pr.head.sha ||
      current.base.ref !== pr.base.ref ||
      target.data.object.sha !== inspectionTargets.get(pr.base.ref).sha
    )
      return false;
  }
  for (const branch of new Set(pulls.map(pr => pr.base.ref))) {
    const target = inspectionTargets.get(branch);
    if (!target.repairRun) continue;
    const current = await targetState(github, context.repo, branch);
    if (current.sha !== target.sha || current.repairRun !== target.repairRun)
      return false;
  }
  return true;
}

async function inspect(github, context, core) {
  if (
    context.eventName === 'workflow_dispatch' &&
    context.payload.inputs.operation === 'approve-repair'
  )
    await approveRepair(github, context);
  const pulls = await github.paginate(github.rest.pulls.list, {
    ...context.repo,
    state: 'open',
    per_page: 100,
  });
  const groups = new Map();
  for (const pr of pulls) {
    if (!groups.has(pr.head.sha)) groups.set(pr.head.sha, []);
    groups.get(pr.head.sha).push(pr);
  }
  for (const sha of groups.keys())
    await status(
      github,
      context.repo,
      sha,
      'pending',
      'Checking the current integration target.',
    );
  const inspectionTargets = new Map();
  for (const [sha, group] of groups) {
    try {
      const healthy = await groupHealthy(
        github,
        context,
        group,
        inspectionTargets,
      );
      await status(
        github,
        context.repo,
        sha,
        healthy ? 'success' : 'failure',
        healthy
          ? 'All current targets are healthy or have an owner-approved repair.'
          : 'A target is unverified, unhealthy, or changed during inspection.',
      );
    } catch (error) {
      core.error(error.message);
      await status(
        github,
        context.repo,
        sha,
        'error',
        'Target verification was unavailable.',
      );
      core.setFailed('At least one target could not be verified.');
    }
  }
}

module.exports = inspect;
module.exports.ciContract = ciContract;
