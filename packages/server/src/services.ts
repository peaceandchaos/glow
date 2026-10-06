import { createRemoteJWKSet } from 'jose';
import { start } from 'workflow/api';
import { replyWorkflow } from '../workflows/reply';
import type { ApiServices } from './api';
import {
  runtimeCatalog,
  runtimeJev,
  runtimeJobs,
  runtimeSessions,
} from './runtime';

const appleKeys = createRemoteJWKSet(
  new URL('https://appleid.apple.com/auth/keys'),
);

export function services(): ApiServices {
  return {
    allowedAppleUserIds: process.env.ALLOWED_APPLE_USER_IDS ?? '',
    appleKeys,
    sessions: runtimeSessions,
    jobs: runtimeJobs,
    async dispatch(owner, attemptId) {
      return (await start(replyWorkflow, [owner, attemptId])).runId;
    },
    rank: (input, signal) => runtimeJev().rank(input, signal),
    catalog: runtimeCatalog(),
  };
}
