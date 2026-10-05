const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const inspect = require('../github/target-health.cjs');

function fixture() {
  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  const state = {
    pr: {
      number: 1,
      state: 'open',
      head: { sha: head },
      base: { ref: 'main' },
    },
    base,
    run: {
      id: 42,
      run_attempt: 1,
      event: 'push',
      head_sha: base,
      head_branch: 'main',
      status: 'completed',
      conclusion: 'success',
    },
    jobs: [
      {
        name: 'verify (commit)',
        conclusion: 'success',
        steps: ['Verify committed source', 'Upload results'].map(name => ({
          name,
          conclusion: 'success',
        })),
      },
      { name: 'post-push-gate', conclusion: 'success' },
    ],
    statuses: [],
    queries: [],
    runLookups: 0,
    onRunLookup: null,
    approvals: [],
    controllerRuns: new Map(),
    nextRunId: 73,
    changedHead: false,
  };
  const api = {
    pulls: {
      list: async () => [state.pr],
      get: async () => ({
        data: state.changedHead
          ? { ...state.pr, head: { sha: 'c'.repeat(40) } }
          : state.pr,
      }),
    },
    git: { getRef: async () => ({ data: { object: { sha: state.base } } }) },
    actions: {
      listWorkflowRuns: async query => {
        state.queries.push(query);
        state.runLookups += 1;
        state.onRunLookup?.(state.runLookups);
        return { data: { workflow_runs: state.run ? [state.run] : [] } };
      },
      listJobsForWorkflowRun: async query => {
        state.queries.push(query);
        return state.jobs;
      },
      getWorkflowRun: async ({ run_id }) => ({
        data: state.controllerRuns.get(run_id),
      }),
    },
    checks: {
      create: async approval => {
        // Hosted GitHub replaces details_url with the check-run page for Actions checks.
        const id = 110107096373 + state.approvals.length;
        state.approvals.push({
          ...approval,
          app: { slug: 'github-actions' },
          details_url: `https://github.com/example-owner/example-repo/runs/${id}`,
        });
      },
      listForRef: async () => state.approvals,
    },
    repos: {
      createCommitStatus: async value => {
        state.statuses.push(value);
      },
    },
  };
  const github = { rest: api, paginate: (endpoint, args) => endpoint(args) };
  const context = {
    repo: { owner: 'example-owner', repo: 'example-repo' },
    eventName: 'workflow_run',
    actor: 'peaceandchaos',
    ref: 'refs/heads/main',
    runId: null,
    payload: { repository: { default_branch: 'main' }, inputs: {} },
  };
  const core = { error: jest.fn(), setFailed: jest.fn() };
  return { state, github, context, core };
}

async function runController(f) {
  const { state, context, core } = f;
  const run = {
    id: state.nextRunId++,
    run_attempt: 1,
    event: context.eventName,
    display_title:
      context.eventName === 'workflow_dispatch'
        ? Object.values(context.payload.inputs).join(' ')
        : 'Target health',
    conclusion: null,
    path: '.github/workflows/target-health.yml',
    actor: { login: context.actor },
    triggering_actor: { login: context.actor },
    head_branch: 'main',
  };
  state.controllerRuns.set(run.id, run);
  context.runId = run.id;
  core.setFailed.mockClear();
  try {
    await inspect(f.github, context, core);
    run.conclusion = core.setFailed.mock.calls.length ? 'failure' : 'success';
  } catch (error) {
    run.conclusion = 'failure';
    throw error;
  }
}

function pointApprovalAtRun(externalId, runId) {
  return externalId.replace(/\d+$/u, String(runId));
}

function repairDispatch(f) {
  f.context.eventName = 'workflow_dispatch';
  f.context.payload.inputs = {
    operation: 'approve-repair',
    pr: '1',
    head: f.state.pr.head.sha,
    base: f.state.base,
  };
}

const lastState = f => f.state.statuses.at(-1).state;

test('metadata controller checks the exact target and latest attempt before publishing on the candidate', async () => {
  const f = fixture();
  await runController(f);
  expect(f.state.queries[0]).toMatchObject({
    branch: 'main',
    event: 'push',
    head_sha: f.state.base,
    workflow_id: 'ci.yml',
    per_page: 1,
  });
  expect(f.state.queries[1]).toMatchObject({ run_id: 42, filter: 'latest' });
  expect(f.state.statuses.map(value => [value.sha, value.state])).toEqual([
    [f.state.pr.head.sha, 'pending'],
    [f.state.pr.head.sha, 'success'],
  ]);
});

test('missing, pending, failed, skipped, and stale verification all hold the candidate', async () => {
  const faults = [
    f => {
      f.state.run = null;
    },
    f => {
      f.state.run.status = 'in_progress';
    },
    f => {
      f.state.run.conclusion = 'failure';
    },
    f => {
      f.state.jobs[0].steps[1].conclusion = 'skipped';
    },
    f => {
      f.state.changedHead = true;
    },
  ];
  for (const fault of faults) {
    const f = fixture();
    fault(f);
    await runController(f);
    expect(lastState(f)).toBe('failure');
  }
});

test('a target that moves during inspection holds candidates published after the move', async () => {
  const f = fixture();
  const second = { ...f.state.pr, number: 2, head: { sha: 'e'.repeat(40) } };
  f.github.rest.pulls.list = async () => [f.state.pr, second];
  f.github.rest.pulls.get = async ({ pull_number }) => ({
    data: pull_number === 2 ? second : f.state.pr,
  });
  const publish = f.github.rest.repos.createCommitStatus;
  f.github.rest.repos.createCommitStatus = async value => {
    await publish(value);
    if (value.state === 'success') f.state.base = 'd'.repeat(40);
  };
  await runController(f);
  expect(f.state.statuses.map(value => [value.sha, value.state])).toEqual([
    [f.state.pr.head.sha, 'pending'],
    [second.head.sha, 'pending'],
    [f.state.pr.head.sha, 'success'],
    [second.head.sha, 'failure'],
  ]);
});

test('owner repair binds PR, head, and base; a changed target invalidates it', async () => {
  const f = fixture();
  f.state.run.conclusion = 'failure';
  repairDispatch(f);
  await runController(f);
  expect(f.state.approvals).toHaveLength(1);
  expect(f.state.approvals[0].external_id).toBe(
    `1:${f.state.pr.head.sha}:${f.state.base}:42:1:73`,
  );
  expect(lastState(f)).toBe('success');
  f.context.eventName = 'workflow_run';
  f.state.base = 'd'.repeat(40);
  await runController(f);
  expect(lastState(f)).toBe('failure');
  f.context.eventName = 'workflow_dispatch';
  f.context.actor = 'agent[bot]';
  await expect(runController(f)).rejects.toThrow('Only the owner');
  expect(f.state.approvals).toHaveLength(1);
});

test('owner repair requires an exact completed target push run that failed verification', async () => {
  const faults = [
    f => {
      f.state.run = null;
    },
    f => {
      f.state.run.status = 'in_progress';
    },
    f => {
      f.state.run.conclusion = 'cancelled';
    },
    f => {
      f.state.run.conclusion = 'success';
    },
    f => {
      f.state.run.head_sha = 'c'.repeat(40);
      f.state.run.conclusion = 'failure';
    },
    f => {
      f.state.run.event = 'pull_request';
      f.state.run.conclusion = 'failure';
    },
  ];
  for (const fault of faults) {
    const f = fixture();
    fault(f);
    repairDispatch(f);
    await expect(runController(f)).rejects.toThrow(
      'no exact completed push run that failed verification',
    );
    expect(f.state.approvals).toHaveLength(0);
  }
});

test('an approved repair expires when the target run or attempt changes', async () => {
  const f = fixture();
  f.state.run.conclusion = 'failure';
  repairDispatch(f);
  await runController(f);
  expect(lastState(f)).toBe('success');

  f.context.eventName = 'workflow_run';
  f.state.run.run_attempt = 2;
  f.state.run.status = 'in_progress';
  f.state.run.conclusion = null;
  await runController(f);
  expect(lastState(f)).toBe('failure');

  f.state.run.status = 'completed';
  f.state.run.conclusion = 'failure';
  await runController(f);
  expect(lastState(f)).toBe('failure');

  f.state.run.run_attempt = 1;
  f.state.run.conclusion = 'cancelled';
  await runController(f);
  expect(lastState(f)).toBe('failure');
  f.state.run.run_attempt = 2;
  f.state.run.conclusion = 'failure';

  f.context.eventName = 'workflow_dispatch';
  await runController(f);
  expect(lastState(f)).toBe('success');
  expect(f.state.approvals.at(-1).external_id).toBe(
    `1:${f.state.pr.head.sha}:${f.state.base}:42:2:${f.context.runId}`,
  );

  f.context.eventName = 'workflow_run';
  f.state.run.id = 43;
  f.state.run.run_attempt = 1;
  await runController(f);
  expect(lastState(f)).toBe('failure');
});

test('a target rerun during inspection prevents repaired success', async () => {
  const f = fixture();
  f.state.run.conclusion = 'failure';
  repairDispatch(f);
  await runController(f);
  expect(lastState(f)).toBe('success');

  f.context.eventName = 'workflow_run';
  f.state.runLookups = 0;
  f.state.onRunLookup = count => {
    if (count !== 2) return;
    f.state.run.run_attempt = 2;
    f.state.run.status = 'in_progress';
    f.state.run.conclusion = null;
  };
  await runController(f);
  expect(lastState(f)).toBe('failure');
});

test('owner repair covers every completed target run that fails verification', async () => {
  const faults = [
    f => {
      f.state.run.conclusion = 'timed_out';
    },
    f => {
      f.state.run.conclusion = 'startup_failure';
    },
    f => {
      f.state.jobs[0].steps[0].name = 'Renamed verification step';
    },
  ];
  for (const fault of faults) {
    const f = fixture();
    fault(f);
    await runController(f);
    expect(lastState(f)).toBe('failure');
    repairDispatch(f);
    await runController(f);
    expect(f.state.approvals.map(value => value.external_id)).toEqual([
      `1:${f.state.pr.head.sha}:${f.state.base}:42:1:${f.context.runId}`,
    ]);
    expect(lastState(f)).toBe('success');
  }
});

test('a rerun of an approval dispatch cannot approve or count as approval', async () => {
  const f = fixture();
  f.state.run.conclusion = 'failure';
  repairDispatch(f);
  await runController(f);
  expect(lastState(f)).toBe('success');

  const approval = f.state.controllerRuns.get(f.context.runId);
  Object.assign(approval, { run_attempt: 2, conclusion: null });
  await expect(inspect(f.github, f.context, f.core)).rejects.toThrow(
    'fresh owner dispatch',
  );
  expect(f.state.approvals).toHaveLength(1);

  approval.conclusion = 'success';
  f.context.eventName = 'workflow_run';
  await runController(f);
  expect(lastState(f)).toBe('failure');
});

test('the controller reads job and step names that the CI workflow defines', () => {
  const { workflow, verifyJob, gateJob, verifySteps } = inspect.ciContract;
  const ci = readFileSync(
    resolve(__dirname, '../../.github/workflows', workflow),
    'utf8',
  );
  const template = 'verify (${{ matrix.revision }})';
  expect(ci).toContain(`name: ${template}`);
  expect(ci).toContain(`'["commit"]'`);
  expect(verifyJob).toBe(template.replace('${{ matrix.revision }}', 'commit'));
  // Push runs must not publish the PR's required check name on the same head SHA.
  expect(gateJob).not.toBe('quality-gate');
  expect(ci).toContain(
    `  quality-gate:\n    name: \${{ github.event_name == 'pull_request' && 'quality-gate' || '${gateJob}' }}\n`,
  );
  for (const step of verifySteps)
    expect(ci).toMatch(new RegExp(`^      - name: ${step}$`, 'mu'));
});

test('repair approval must come from a successful dispatch with the same inputs', async () => {
  const f = fixture();
  f.state.run.conclusion = 'failure';
  repairDispatch(f);
  await runController(f);
  expect(lastState(f)).toBe('success');
  const approval = f.state.controllerRuns.get(f.context.runId);

  f.context.payload.inputs = {
    operation: 'refresh',
    pr: '',
    head: '',
    base: '',
  };
  await runController(f);
  expect(lastState(f)).toBe('success');
  const refresh = f.context.runId;

  f.context.eventName = 'workflow_run';
  approval.conclusion = 'failure';
  await runController(f);
  expect(lastState(f)).toBe('failure');

  approval.conclusion = 'success';
  const check = f.state.approvals[0];
  check.external_id = pointApprovalAtRun(check.external_id, refresh);
  await runController(f);
  expect(lastState(f)).toBe('failure');
});
