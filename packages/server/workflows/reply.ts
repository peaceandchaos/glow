import { getStepMetadata, getWorkflowMetadata } from 'workflow';
import { runtimeJobs, runtimeProviders } from '../src/runtime';
import { runAttempt } from '../src/worker';

export async function replyWorkflow(
  owner: string,
  attemptId: string,
): Promise<void> {
  'use workflow';
  await waitForCommittedInput(owner, attemptId);
  await generateReply(owner, attemptId);
}

async function waitForCommittedInput(
  owner: string,
  attemptId: string,
): Promise<void> {
  'use step';
  // Dispatch can reach this read just before the submit transaction commits.
  await (await runtimeJobs()).get(owner, attemptId);
}

async function generateReply(owner: string, attemptId: string): Promise<void> {
  'use step';
  await runAttempt({
    owner,
    attemptId,
    jobs: await runtimeJobs(),
    providers: runtimeProviders(),
    runId: getWorkflowMetadata().workflowRunId,
    claimId: getStepMetadata().stepId,
  });
}

// A failed or ambiguous provider call must not turn into another paid attempt.
generateReply.maxRetries = 0;
waitForCommittedInput.maxRetries = 3;
