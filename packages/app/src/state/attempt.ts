import {
  isTerminal,
  type AttemptSnapshot,
  type JobEvent,
} from '../../../../shared/contracts';
import {
  parseGatewayEvent,
  parseResponsesEvent,
  type ParsedProviderEvent,
  type ReplyLabel,
} from '../../../../shared/provider-events';
import type { SavedMessage } from './archive';

// Where a reply attempt stands between this phone and the server. The archive
// stores it as v1 flags; phaseOf is the only reader of those flags.
type AttemptPhase =
  | 'unsent' // saved here; the server may or may not hold it
  | 'accepted' // the server holds it; the result is not final here yet
  | 'cancel-pending' // Stop is saved here; the server has not confirmed it
  | 'unacknowledged' // the final result is saved here; receipt not yet confirmed
  | 'settled';

export type Operation = 'submit' | 'watch' | 'stop' | 'acknowledge';

export const nextOperation: Record<AttemptPhase, Operation | null> = {
  unsent: 'submit',
  accepted: 'watch',
  'cancel-pending': 'stop',
  unacknowledged: 'acknowledge',
  settled: null,
};

export class UnsupportedRecord extends Error {}

export function phaseOf(message: SavedMessage): AttemptPhase {
  if (message.role !== 'assistant')
    throw new UnsupportedRecord('This saved message is not a reply.');
  const final = message.status !== 'pending' && isTerminal(message.status);
  if (message.acknowledged) {
    if (!final)
      throw new UnsupportedRecord('A saved reply is settled but unfinished.');
    return 'settled';
  }
  if (final) {
    if (!message.accepted)
      throw new UnsupportedRecord('A saved reply finished before acceptance.');
    return 'unacknowledged';
  }
  if (message.cancelPending) return 'cancel-pending';
  if (message.accepted === (message.status === 'pending'))
    throw new UnsupportedRecord('A saved reply has an unknown server state.');
  return message.accepted ? 'accepted' : 'unsent';
}

export type Applied =
  | { kind: 'ignored' }
  | { kind: 'progress'; message: SavedMessage; label?: ReplyLabel }
  // Acceptance, a final result, or a confirmed receipt: save before continuing.
  | { kind: 'durable'; message: SavedMessage }
  // A missing or unreadable update. A fresh snapshot repairs it.
  | { kind: 'reattach'; error: string }
  // The server no longer holds a result this phone never saved.
  | { kind: 'lost'; error: string }
  | { kind: 'rejected'; error: string };

const ignored: Applied = { kind: 'ignored' };

export function applySnapshot(
  message: SavedMessage,
  snapshot: AttemptSnapshot,
): Applied {
  if (
    snapshot.attemptId !== message.id ||
    snapshot.chatId !== message.chatId ||
    snapshot.pathId !== message.pathId ||
    snapshot.userTurnId !== message.parentId
  )
    return { kind: 'rejected', error: 'Reply identity mismatch.' };
  const phase = phaseOf(message);
  if (phase === 'settled') return ignored;
  if (snapshot.delivered) {
    // The server purged its copy after an earlier receipt. Never replace the
    // saved answer with that empty receipt.
    if (phase === 'unacknowledged')
      return { kind: 'durable', message: { ...message, acknowledged: true } };
    return {
      kind: 'lost',
      error:
        'The server released this reply before the phone saved it. Your saved text was preserved.',
    };
  }
  if (message.accepted && snapshot.sequence <= message.sequence) return ignored;
  const final = isTerminal(snapshot.status);
  const next: SavedMessage = {
    ...message,
    accepted: true,
    sequence: snapshot.sequence,
    status: snapshot.status,
    actualModel: snapshot.actualModel,
    text: snapshot.text,
    reasoning: snapshot.reasoning,
    error: snapshot.error,
    checkpoint: snapshot.checkpoint,
    cancelPending: final ? false : message.cancelPending,
  };
  return final || !message.accepted
    ? { kind: 'durable', message: next }
    : { kind: 'progress', message: next };
}

function parseProvider(event: JobEvent & { kind: 'provider' }) {
  return event.wire === 'responses'
    ? parseResponsesEvent(event.raw)
    : parseGatewayEvent(event.raw);
}

export function applyEvent(message: SavedMessage, event: JobEvent): Applied {
  if (event.attemptId !== message.id)
    return { kind: 'rejected', error: 'Reply identity mismatch.' };
  if (event.kind === 'snapshot')
    return event.snapshot.sequence === event.sequence
      ? applySnapshot(message, event.snapshot)
      : { kind: 'rejected', error: 'Reply cursor mismatch.' };
  if (phaseOf(message) === 'settled' || event.sequence <= message.sequence)
    return ignored;
  if (!message.accepted || event.sequence !== message.sequence + 1)
    return { kind: 'reattach', error: 'Reply delivery skipped an update.' };
  const next: SavedMessage = { ...message, sequence: event.sequence };
  if (event.kind === 'status') {
    // Only the authoritative terminal snapshot finishes an attempt.
    if (!isTerminal(event.status)) next.status = event.status;
    next.actualModel = event.actualModel;
    return { kind: 'progress', message: next };
  }
  let parsed: ParsedProviderEvent;
  try {
    parsed = parseProvider(event);
  } catch {
    return { kind: 'reattach', error: 'A reply update could not be read.' };
  }
  if (parsed.kind === 'status')
    return { kind: 'progress', message: next, label: parsed.label };
  if (parsed.kind === 'delta') next.text += parsed.text;
  if (parsed.kind === 'reasoning') next.reasoning += parsed.text;
  return { kind: 'progress', message: next };
}

type FailurePlan =
  | { kind: 'retry'; error: string }
  // The server refused an attempt it never accepted.
  | { kind: 'reject'; error: string }
  // The server no longer has an attempt it accepted.
  | { kind: 'lost'; error: string }
  // Nothing remains to confirm on the server.
  | { kind: 'settle' }
  | { kind: 'halt'; error: string };

const connectionLost = 'Connection interrupted. This reply will reconnect.';

// status is null when the request failed before an HTTP status was known.
export function planFailure(
  operation: Operation,
  status: number | null,
  serverMessage: string,
): FailurePlan {
  if (status === 401)
    return {
      kind: 'retry',
      error:
        'This phone is not allowed by the server. Add its device ID to the server allowlist.',
    };
  if (operation === 'stop')
    return {
      kind: 'retry',
      error: 'Stop is pending. It will be sent when the server is reachable.',
    };
  if (
    status === null ||
    status === 408 ||
    status === 429 ||
    status < 400 ||
    status >= 500
  )
    return { kind: 'retry', error: connectionLost };
  switch (operation) {
    case 'submit':
      return { kind: 'reject', error: serverMessage };
    case 'watch':
      return status === 404
        ? {
            kind: 'lost',
            error:
              'The server cannot find this reply. Your saved text was preserved. Retry creates a new answer.',
          }
        : { kind: 'retry', error: connectionLost };
    case 'acknowledge':
      return status === 404
        ? { kind: 'settle' }
        : {
            kind: 'halt',
            error:
              'The server did not accept this reply’s receipt. Your saved reply is unchanged.',
          };
  }
}

// The server answers 204 for unknown and repeated deletions. 404 and 410 from
// an older server or a proxy also mean nothing is left to delete.
export function planDeletionFailure(
  status: number | null,
): 'deleted' | 'retry' | 'refused' {
  if (status === 404 || status === 410) return 'deleted';
  if (
    status === null ||
    status === 401 ||
    status === 408 ||
    status === 429 ||
    status < 400 ||
    status >= 500
  )
    return 'retry';
  return 'refused';
}
