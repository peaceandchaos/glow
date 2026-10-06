import { getStepMetadata, getWorkflowMetadata } from 'workflow';
import { runtimeCatalog, runtimeJobs, runtimeProviders } from '../src/runtime';
import { runAttempt } from '../src/worker';

export async function replyWorkflow(
  owner: string,
  attemptId: string,
): Promise<void> {
  'use workflow';
  await generateReply(owner, attemptId);
}

async function generateReply(owner: string, attemptId: string): Promise<void> {
  'use step';
  await runAttempt({
    owner,
    attemptId,
    jobs: await runtimeJobs(),
    providers: runtimeProviders(),
    catalog: runtimeCatalog(),
    runId: getWorkflowMetadata().workflowRunId,
    claimId: getStepMetadata().stepId,
  });
}

// A failed or ambiguous provider call must not turn into another paid attempt.
generateReply.maxRetries = 0;
