type Range = Readonly<{ content: string; startOffset: string; endOffset: string; hasMore: boolean }>;
type Snapshot = Range & Readonly<{ loading: boolean; error: boolean; hasPrevious: boolean }>;

export class TranscriptContentReader {
  private snapshot: Snapshot = {
    content: "", startOffset: "0", endOffset: "0", hasMore: true,
    loading: false, error: false, hasPrevious: false,
  };
  private readonly listeners = new Set<() => void>();
  private readonly controller = new AbortController();
  private readonly offsets = ["0"];
  private index = 0;
  private requestedIndex = 0;
  private readonly read: (offset: string, signal: AbortSignal) => Promise<Range>;
  private readonly mode: "text" | "output";

  constructor(read: (offset: string, signal: AbortSignal) => Promise<Range>, mode: "text" | "output") {
    this.read = read;
    this.mode = mode;
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

  async load(index = this.requestedIndex) {
    if (this.snapshot.loading || this.controller.signal.aborted) return;
    this.requestedIndex = index;
    this.publish({ loading: true, error: false });
    try {
      let offset = this.offsets[index];
      const parts: string[] = [];
      while (true) {
        const page = await this.read(offset, this.controller.signal);
        if (this.controller.signal.aborted) return;
        if (page.startOffset !== offset || (page.hasMore && BigInt(page.endOffset) <= BigInt(offset))) {
          throw new Error("transcript content continuation made no progress");
        }
        if (this.mode === "output") {
          this.index = index;
          this.publish({ ...page, hasPrevious: index > 0 });
          break;
        }
        parts.push(page.content);
        if (!page.hasMore) {
          // Transport chunks are not Markdown boundaries. Publish one complete document.
          this.publish({ ...page, content: parts.join(""), startOffset: "0" });
          break;
        }
        offset = page.endOffset;
      }
    } catch {
      this.publish({ error: true });
    } finally {
      this.publish({ loading: false });
    }
  }
  async next() {
    if (this.snapshot.loading || !this.snapshot.hasMore) return;
    this.offsets[this.index + 1] = this.snapshot.endOffset;
    await this.load(this.index + 1);
  }
  async previous() {
    if (this.index > 0) await this.load(this.index - 1);
  }
}
