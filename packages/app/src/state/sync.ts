import type { SyncTransport } from '../network/transport';
import type { ChatArchive, RemoteChange } from './archive';

// Pulls every server change, then pushes the outbox. A failed run keeps what
// it saved so far, and the next run continues from the saved cursor and outbox.
export class ChatSync {
  private flight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private again = false;

  constructor(
    private readonly archive: ChatArchive,
    private readonly transport: SyncTransport,
    private readonly applied: (change: RemoteChange) => void,
  ) {}

  run(): Promise<void> {
    if (this.flight) {
      this.again = true;
      return this.flight;
    }
    const controller = new AbortController();
    this.controller = controller;
    const flight = this.loop(controller.signal)
      .catch(() => undefined)
      .finally(() => {
        if (this.flight === flight) this.flight = null;
      });
    this.flight = flight;
    return flight;
  }

  stop(): void {
    this.controller?.abort();
    this.controller = null;
    this.flight = null;
    this.again = false;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    do {
      this.again = false;
      for (let more = true; more;) {
        const after = this.archive.cursor();
        const page = await this.transport.pull(after, signal);
        if (signal.aborted) return;
        this.applied(this.archive.applyRemote(page));
        more = page.more && page.cursor > after;
      }
      for (
        let batch = this.archive.outboxBatch();
        batch;
        batch = this.archive.outboxBatch()
      ) {
        await this.transport.push(batch, signal);
        if (signal.aborted) return;
        this.archive.clearPushed(batch);
      }
    } while (this.again);
  }
}
