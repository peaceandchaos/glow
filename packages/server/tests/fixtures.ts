import { randomUUID } from 'node:crypto';
import type { Submission } from '../../../shared/contracts';

export function submission(): Submission {
  const userTurnId = randomUUID();
  return {
    version: 1,
    attemptId: randomUUID(),
    chatId: randomUUID(),
    pathId: randomUUID(),
    userTurnId,
    picker: 'auto',
    retryModel: null,
    history: [
      {
        id: userTurnId,
        parentId: null,
        role: 'user',
        text: 'Hello',
        images: [],
        complete: true,
      },
    ],
    checkpoints: [],
  };
}
