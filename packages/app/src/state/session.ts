import type { ModelKey } from '../../../../shared/contracts';
import type { ReplyLabel } from '../../../../shared/provider-events';
import {
  TransportError,
  type ChatTransport,
  type Receive,
} from '../network/transport';
import type { ChatArchive, SavedMessage } from './archive';
import {
  applyEvent,
  applySnapshot,
  nextOperation,
  phaseOf,
  planDeletionFailure,
  planFailure,
  UnsupportedRecord,
  type Applied,
  type Operation,
} from './attempt';

// Mirrors React Native's AppStateStatus without importing React Native.
type LifecycleState =
  | 'active'
  | 'inactive'
  | 'background'
  | 'unknown'
  | 'extension';

export type AttemptActivity =
  | { kind: 'idle' }
  | { kind: 'connected'; label: ReplyLabel }
  | { kind: 'waiting'; error: string }
  | { kind: 'halted'; error: string };

type SessionOptions = {
  archive: ChatArchive;
  transport: ChatTransport;
  scheduleFrame: (callback: () => void) => void;
  checkpointMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
};

// Why a reader was aborted by this phone. None of these cancel server work.
type Interruption =
  | { kind: 'relaunch' }
  | { kind: 'detach' }
  | { kind: 'reattach'; error: string }
  | { kind: 'halt'; error: string };

type Running = {
  kind: 'running';
  controller: AbortController;
  failures: number;
  operation: Operation;
  interruption: Interruption | null;
  label: ReplyLabel;
};
type Runner =
  | Running
  | {
      kind: 'waiting';
      timer: ReturnType<typeof setTimeout>;
      failures: number;
      error: string;
    }
  | { kind: 'halted'; error: string };

type DeletionRunner =
  | { kind: 'running'; controller: AbortController; failures: number }
  | { kind: 'waiting'; timer: ReturnType<typeof setTimeout>; failures: number };

class LocalDataError extends Error {}

const storageError =
  'Saved chats could not be updated. Stored data was preserved.';
const deletionRefused =
  'The server refused to delete a chat. It stays deleted on this phone, and the app tries again when reopened.';
const deletionPending =
  'Chat deletion is pending on the server. It will retry when connected.';

export class ChatSession {
  private readonly archive: ChatArchive;
  private readonly transport: ChatTransport;
  private readonly scheduleFrame: (callback: () => void) => void;
  private readonly checkpointMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  // Unsettled attempts. These copies can be ahead of storage between checkpoints.
  private readonly live = new Map<string, SavedMessage>();
  private readonly dirty = new Set<string>();
  private readonly runners = new Map<string, Runner>();
  private readonly listeners = new Set<() => void>();
  private checkpointTimer: ReturnType<typeof setTimeout> | null = null;
  private framePending = false;
  private foreground = false;
  private deletion: DeletionRunner | null = null;
  private storageProblem: string | null = null;
  private deletionProblem: string | null = null;
  // Chats whose server deletion was refused; retried on the next resume.
  private readonly refusedDeletions = new Set<string>();

  constructor(options: SessionOptions) {
    this.archive = options.archive;
    this.transport = options.transport;
    this.scheduleFrame = options.scheduleFrame;
    this.checkpointMs = options.checkpointMs ?? 1000;
    this.retryBaseMs = options.retryBaseMs ?? 1000;
    this.retryMaxMs = options.retryMaxMs ?? 30_000;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  message(id: string): SavedMessage {
    return this.live.get(id) ?? this.archive.message(id);
  }

  path(leafId: string | null, limit?: number): SavedMessage[] {
    return this.archive
      .ancestry(leafId, limit)
      .map(message => this.live.get(message.id) ?? message);
  }

  activity(id: string): AttemptActivity {
    const runner = this.runners.get(id);
    if (!runner) return { kind: 'idle' };
    if (runner.kind === 'running')
      return { kind: 'connected', label: runner.label };
    return { kind: runner.kind, error: runner.error };
  }

  notice(): string | null {
    return this.storageProblem ?? this.deletionProblem;
  }

  pendingDeletions(): string[] {
    return this.archive.metadata().deletions;
  }

  send(chatId: string, text: string, images: string[]): SavedMessage {
    this.flush();
    return this.begin(this.archive.createTurn(chatId, text, images));
  }

  retry(replyId: string, model?: ModelKey): SavedMessage {
    this.flush();
    return this.begin(this.archive.retry(replyId, model));
  }

  stop(replyId: string): void {
    const message = this.loadUnsettled(replyId);
    if (!message) return;
    const phase = phaseOf(message);
    if (phase !== 'unsent' && phase !== 'accepted') return;
    this.update(replyId, { ...message, cancelPending: true });
    try {
      this.flush();
    } finally {
      // Detach the current reader; the next run sends Stop.
      this.launch(replyId);
      this.notify();
    }
  }

  deleteChat(chatId: string): void {
    this.archive.deleteChat(chatId);
    for (const [id, message] of this.live) {
      if (message.chatId !== chatId) continue;
      this.live.delete(id);
      this.dirty.delete(id);
      this.dropRunner(id);
    }
    this.launchDeletions();
    this.notify();
  }

  setLifecycle(state: LifecycleState): void {
    if (state === 'active') {
      this.resume();
      return;
    }
    this.checkpoint();
    if (state === 'background') this.detach();
  }

  private resume(): void {
    this.foreground = true;
    this.catchStorageFailure(() => {
      for (const id of this.archive.metadata().jobIds) {
        const runner = this.runners.get(id);
        if (runner?.kind === 'running' || runner?.kind === 'waiting') continue;
        let message: SavedMessage | null;
        try {
          message = this.loadUnsettled(id);
        } catch {
          this.runners.set(id, {
            kind: 'halted',
            error:
              'This saved reply could not be read. Stored data was preserved.',
          });
          continue;
        }
        if (message) this.launch(id);
        else this.catchStorageFailure(() => this.archive.acknowledge(id));
      }
    });
    this.refusedDeletions.clear();
    this.launchDeletions();
    this.notify();
  }

  private detach(): void {
    this.foreground = false;
    for (const [id, runner] of this.runners)
      if (runner.kind !== 'halted') this.dropRunner(id);
    if (this.deletion?.kind === 'running') this.deletion.controller.abort();
    if (this.deletion?.kind === 'waiting') clearTimeout(this.deletion.timer);
    this.deletion = null;
    this.transport.disconnect();
    this.notify();
  }

  private begin(reply: SavedMessage): SavedMessage {
    this.live.set(reply.id, reply);
    this.launch(reply.id);
    this.notify();
    return reply;
  }

  private loadUnsettled(id: string): SavedMessage | null {
    const cached = this.live.get(id);
    if (cached) return cached;
    const saved = this.local(() => this.archive.message(id));
    if (phaseOf(saved) === 'settled') return null;
    this.live.set(id, saved);
    return saved;
  }

  private update(id: string, message: SavedMessage): void {
    this.live.set(id, message);
    this.dirty.add(id);
  }

  private dropRunner(id: string): void {
    const runner = this.runners.get(id);
    this.runners.delete(id);
    if (runner?.kind === 'running') {
      runner.interruption = { kind: 'detach' };
      runner.controller.abort();
    }
    if (runner?.kind === 'waiting') clearTimeout(runner.timer);
  }

  private launch(id: string): void {
    const existing = this.runners.get(id);
    if (existing?.kind === 'running') {
      this.interrupt(existing, { kind: 'relaunch' });
      return;
    }
    if (!this.foreground) return;
    let failures = 0;
    if (existing?.kind === 'waiting') {
      clearTimeout(existing.timer);
      failures = existing.failures;
    }
    const runner: Running = {
      kind: 'running',
      controller: new AbortController(),
      failures,
      operation: 'submit',
      interruption: null,
      label: 'Thinking',
    };
    this.runners.set(id, runner);
    void this.drive(id, runner).then(
      () => this.finishRun(id, runner, null),
      (error: Error) => this.finishRun(id, runner, error),
    );
  }

  private interrupt(runner: Running, interruption: Interruption): void {
    if (!runner.interruption || interruption.kind === 'halt')
      runner.interruption = interruption;
    runner.controller.abort();
  }

  private async drive(id: string, runner: Running): Promise<void> {
    const { signal } = runner.controller;
    const receive = this.receiver(id, runner);
    for (;;) {
      const message = this.live.get(id);
      if (!message) return;
      const phase = phaseOf(message);
      const operation = nextOperation[phase];
      if (!operation) {
        this.local(() => {
          this.flush();
          this.archive.acknowledge(id);
        });
        this.live.delete(id);
        return;
      }
      runner.operation = operation;
      await this.perform(operation, message, receive, signal);
      if (signal.aborted) return;
      const after = this.live.get(id);
      if (
        after &&
        phaseOf(after) === phase &&
        after.sequence === message.sequence
      )
        throw new Error('The reply stream ended before the reply finished.');
    }
  }

  private async perform(
    operation: Operation,
    message: SavedMessage,
    receive: Receive,
    signal: AbortSignal,
  ): Promise<void> {
    const id = message.id;
    switch (operation) {
      case 'submit': {
        const submission = this.local(() => this.archive.submission(id));
        await this.transport.submit(submission, receive, signal);
        return;
      }
      case 'watch': {
        const snapshot = await this.transport.get(id, signal);
        receive({ kind: 'accepted', snapshot });
        const current = this.live.get(id);
        if (signal.aborted || !current || phaseOf(current) !== 'accepted')
          return;
        await this.transport.watch(snapshot, receive, signal);
        return;
      }
      case 'stop': {
        const snapshot = await this.transport.stop(id, signal);
        if (signal.aborted) return;
        // No snapshot: the server never accepted it and now holds a tombstone.
        if (snapshot) receive({ kind: 'accepted', snapshot });
        else this.settleLocally(id, 'stopped', null);
        return;
      }
      case 'acknowledge':
        this.local(() => this.flush());
        await this.transport.acknowledge(id, message.sequence, signal);
        if (!signal.aborted)
          this.update(id, { ...message, acknowledged: true });
    }
  }

  private receiver(id: string, runner: Running): Receive {
    return message => {
      if (runner.controller.signal.aborted) return;
      const current = this.live.get(id);
      if (!current) return;
      if (message.kind === 'accepted')
        this.apply(id, runner, applySnapshot(current, message.snapshot));
      else if (message.kind === 'event')
        this.apply(id, runner, applyEvent(current, message.event));
    };
  }

  private apply(id: string, runner: Running, applied: Applied): void {
    switch (applied.kind) {
      case 'ignored':
        return;
      case 'progress':
        runner.failures = 0;
        if (applied.label) runner.label = applied.label;
        this.update(id, applied.message);
        this.scheduleCheckpoint();
        this.render();
        return;
      case 'durable':
        runner.failures = 0;
        this.update(id, applied.message);
        try {
          this.flush();
        } catch {
          this.interrupt(runner, { kind: 'halt', error: storageError });
        }
        this.notify();
        return;
      case 'reattach':
        this.interrupt(runner, applied);
        return;
      case 'lost':
        this.settleLocally(id, 'interrupted', applied.error);
        this.interrupt(runner, { kind: 'relaunch' });
        return;
      case 'rejected':
        this.interrupt(runner, { kind: 'halt', error: applied.error });
    }
  }

  private finishRun(id: string, runner: Running, error: Error | null): void {
    if (this.runners.get(id) !== runner) return;
    this.runners.delete(id);
    this.checkpoint();
    const interruption = runner.interruption;
    if (interruption?.kind === 'halt') this.halt(id, interruption.error);
    else if (interruption?.kind === 'relaunch') this.launch(id);
    else if (interruption?.kind === 'reattach')
      this.wait(id, runner.failures + 1, interruption.error);
    else if (error) this.recover(id, runner, error);
    this.notify();
  }

  private recover(id: string, runner: Running, error: Error): void {
    if (error instanceof LocalDataError || error instanceof UnsupportedRecord) {
      this.halt(id, error.message);
      return;
    }
    const plan = planFailure(
      runner.operation,
      error instanceof TransportError ? error.status : null,
      error.message,
    );
    switch (plan.kind) {
      case 'retry':
        this.wait(id, runner.failures + 1, plan.error);
        return;
      case 'reject':
        this.settleLocally(id, 'failed', plan.error);
        this.launch(id);
        return;
      case 'lost':
        this.settleLocally(id, 'interrupted', plan.error);
        this.launch(id);
        return;
      case 'settle': {
        const message = this.live.get(id);
        if (message) this.update(id, { ...message, acknowledged: true });
        this.launch(id);
        return;
      }
      case 'halt':
        this.halt(id, plan.error);
    }
  }

  private settleLocally(
    id: string,
    status: 'failed' | 'stopped' | 'interrupted',
    error: string | null,
  ): void {
    const message = this.live.get(id);
    if (!message) return;
    this.update(id, {
      ...message,
      status,
      error,
      cancelPending: false,
      acknowledged: true,
    });
  }

  private wait(id: string, failures: number, error: string): void {
    const delay = Math.min(
      this.retryBaseMs * 2 ** (failures - 1),
      this.retryMaxMs,
    );
    const timer = setTimeout(() => {
      if (this.runners.get(id) === waiting) this.launch(id);
    }, delay);
    const waiting: Runner = { kind: 'waiting', timer, failures, error };
    this.runners.set(id, waiting);
  }

  private halt(id: string, error: string): void {
    this.runners.set(id, { kind: 'halted', error });
  }

  private launchDeletions(): void {
    if (this.deletion?.kind === 'running' || !this.foreground) return;
    let failures = 0;
    if (this.deletion?.kind === 'waiting') {
      clearTimeout(this.deletion.timer);
      failures = this.deletion.failures;
    }
    this.deletion = null;
    const pendingDeletions = this.catchStorageFailure(
      () => this.archive.metadata().deletions.length,
    );
    const indexUnreadable = pendingDeletions === null;
    if (!indexUnreadable && pendingDeletions === 0) return;
    const run: DeletionRunner = {
      kind: 'running',
      controller: new AbortController(),
      failures,
    };
    this.deletion = run;
    void this.deletePending(run.controller.signal).then(
      () => {
        if (this.deletion !== run) return;
        this.deletion = null;
        this.deletionProblem =
          this.refusedDeletions.size > 0 ? deletionRefused : null;
        this.notify();
      },
      (error: Error) => {
        if (this.deletion !== run) return;
        if (error instanceof LocalDataError) this.storageProblem = storageError;
        else this.deletionProblem = deletionPending;
        const timer = setTimeout(
          () => {
            if (this.deletion?.kind === 'waiting') this.launchDeletions();
          },
          Math.min(this.retryBaseMs * 2 ** run.failures, this.retryMaxMs),
        );
        this.deletion = { kind: 'waiting', timer, failures: run.failures + 1 };
        this.notify();
      },
    );
  }

  private async deletePending(signal: AbortSignal): Promise<void> {
    for (;;) {
      const id = this.local(() => this.archive.metadata()).deletions.find(
        chatId => !this.refusedDeletions.has(chatId),
      );
      if (!id) return;
      try {
        await this.transport.deleteChat(id, signal);
      } catch (error) {
        const plan = planDeletionFailure(
          error instanceof TransportError ? error.status : null,
        );
        if (plan === 'retry' || signal.aborted) throw error;
        if (plan === 'refused') {
          this.refusedDeletions.add(id);
          continue;
        }
      }
      if (signal.aborted) return;
      this.local(() => this.archive.finishDeletion(id));
    }
  }

  private local<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof LocalDataError) throw error;
      throw new LocalDataError(
        error instanceof Error && error.message ? error.message : storageError,
      );
    }
  }

  private flush(): void {
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = null;
    if (this.dirty.size === 0) return;
    const messages: SavedMessage[] = [];
    for (const id of this.dirty) {
      const message = this.live.get(id);
      if (message) messages.push(message);
    }
    try {
      this.archive.saveMessages(messages);
    } catch {
      throw new LocalDataError(storageError);
    }
    this.dirty.clear();
    this.storageProblem = null;
  }

  private catchStorageFailure<T>(operation: () => T): T | null {
    try {
      return operation();
    } catch {
      this.storageProblem = storageError;
      return null;
    }
  }

  private checkpoint(): void {
    this.catchStorageFailure(() => this.flush());
  }

  private scheduleCheckpoint(): void {
    this.checkpointTimer ??= setTimeout(() => {
      this.checkpointTimer = null;
      this.checkpoint();
      this.notify();
    }, this.checkpointMs);
  }

  private render(): void {
    if (this.framePending) return;
    this.framePending = true;
    this.scheduleFrame(() => {
      this.framePending = false;
      this.notify();
    });
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
