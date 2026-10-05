import { start } from 'workflow/api';
import { replyWorkflow } from '../workflows/reply';
import type { ApiServices } from './api';
import { runtimeJev, runtimeJobs } from './runtime';

export function services(): ApiServices {
  return {
    allowlist: process.env.ALLOWED_DEVICE_IDS ?? '',
    jobs: runtimeJobs,
    async dispatch(owner, attemptId) {
      return (await start(replyWorkflow, [owner, attemptId])).runId;
    },
    rank: (input, signal) => runtimeJev().rank(input, signal),
  };
}
