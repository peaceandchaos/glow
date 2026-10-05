import { getStepMetadata, getWorkflowMetadata, getWritable } from 'workflow';
import type { JobEvent } from '../../../shared/contracts';
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
  const writer = getWritable<JobEvent>().getWriter();
  let streamAvailable = true;
  try {
    await runAttempt({
      owner,
      attemptId,
      jobs: await runtimeJobs(),
      providers: runtimeProviders(),
      runId: getWorkflowMetadata().workflowRunId,
      claimId: getStepMetadata().stepId,
      async publish(events) {
        if (!streamAvailable) return;
        try {
          for (const event of events) await writer.write(event);
        } catch {
          streamAvailable = false;
        } // SQL already holds the event and complete result.
      },
    });
  } finally {
    await writer.close().catch(() => undefined);
    writer.releaseLock();
  }
}

// A failed or ambiguous provider call must not turn into another paid attempt.
generateReply.maxRetries = 0;
waitForCommittedInput.maxRetries = 3;
