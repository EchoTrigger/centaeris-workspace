type Range = Readonly<{ content: string; startOffset: string; endOffset: string; hasMore: boolean }>;
type Snapshot = Readonly<{ content: string; loading: boolean; error: boolean; hasMore: boolean }>;

// Tool output can be arbitrarily large. Stop automatic continuation once this
// many bytes have been read; the caller still holds what was already loaded.
const MAX_ACCUMULATED_BYTES = 16 * 1024 * 1024;

export class TranscriptContentReader {
  private snapshot: Snapshot = { content: "", loading: false, error: false, hasMore: true };
  private readonly listeners = new Set<() => void>();
  private readonly controller = new AbortController();
  private endOffset = "0";
  private readonly read: (offset: string, signal: AbortSignal) => Promise<Range>;

  constructor(read: (offset: string, signal: AbortSignal) => Promise<Range>) {
    this.read = read;
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  dispose() { this.controller.abort(); this.listeners.clear(); }
  private publish(update: Partial<Snapshot>) {
    if (this.controller.signal.aborted) return;
    this.snapshot = { ...this.snapshot, ...update };
    this.listeners.forEach((listener) => listener());
  }

  async loadMore() {
    if (this.snapshot.loading || this.controller.signal.aborted || !this.snapshot.hasMore) return;
    if (BigInt(this.endOffset) >= BigInt(MAX_ACCUMULATED_BYTES)) {
      this.publish({ hasMore: false });
      return;
    }
    this.publish({ loading: true, error: false });
    try {
      const page = await this.read(this.endOffset, this.controller.signal);
      if (this.controller.signal.aborted) return;
      if (page.startOffset !== this.endOffset
        || (page.hasMore && BigInt(page.endOffset) <= BigInt(this.endOffset))) {
        throw new Error("transcript content continuation made no progress");
      }
      this.endOffset = page.endOffset;
      this.publish({
        content: this.snapshot.content + page.content,
        hasMore: page.hasMore,
        loading: false,
      });
    } catch {
      if (this.controller.signal.aborted) return;
      this.publish({ loading: false, error: true });
    }
  }

  async loadAll() {
    while (this.snapshot.hasMore && !this.snapshot.error) {
      await this.loadMore();
    }
  }

  retry() {
    this.publish({ error: false });
    return this.loadMore();
  }
}
