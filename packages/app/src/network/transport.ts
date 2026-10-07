import type {
  AttemptSnapshot,
  SearchHit,
  ServerMessage,
  Submission,
  SyncPage,
  SyncPush,
} from '../../../../shared/contracts';

export class TransportError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// This phone already has a reader for the attempt. It says nothing about the
// server's view of the attempt, so it is not a TransportError.
export class ReaderConflict extends Error {
  constructor() {
    super('This reply already has an attached reader.');
  }
}

export type Receive = (message: ServerMessage) => void;

export interface ChatTransport {
  get(id: string, signal: AbortSignal): Promise<AttemptSnapshot>;
  submit(
    input: Submission,
    receive: Receive,
    signal: AbortSignal,
  ): Promise<void>;
  watch(
    snapshot: AttemptSnapshot,
    receive: Receive,
    signal: AbortSignal,
  ): Promise<void>;
  stop(id: string, signal: AbortSignal): Promise<AttemptSnapshot | null>;
  acknowledge(id: string, sequence: number, signal: AbortSignal): Promise<void>;
  deleteChat(id: string, signal: AbortSignal): Promise<void>;
  disconnect(): void;
}

export interface SyncTransport {
  pull(after: number, signal: AbortSignal): Promise<SyncPage>;
  push(batch: SyncPush, signal: AbortSignal): Promise<void>;
  search(query: string, signal: AbortSignal): Promise<SearchHit[]>;
}
