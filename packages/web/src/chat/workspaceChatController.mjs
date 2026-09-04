const DEFAULT_MAX_ITEMS_PER_FRAME = 128;
const DEFAULT_REDUCER_BUDGET_MS = 4;
const DEFAULT_QUEUE_HIGH_WATER_MARK = 512;
const TERMINALS = new Set(["agent_run_completed", "agent_run_failed", "agent_run_interrupted"]);

function canCoalesce(left, right) {
  return left?.item.kind === "live"
    && right?.item.kind === "live"
    && left.item.agentRunId === right.item.agentRunId
    && left.item.messageId === right.item.messageId;
}

export function coalesceAdjacentStreamEntries(entries) {
  const result = [];
  for (const entry of entries) {
    if (canCoalesce(result.at(-1), entry)) result[result.length - 1] = entry;
    else result.push(entry);
  }
  return result;
}

export class WorkspaceChatController {
  constructor({
    store,
    workspaceId,
    sessionId,
    agentRunId,
    initialCursor = "0-0",
    maxItemsPerFrame = DEFAULT_MAX_ITEMS_PER_FRAME,
    reducerBudgetMs = DEFAULT_REDUCER_BUDGET_MS,
    queueHighWaterMark = DEFAULT_QUEUE_HIGH_WATER_MARK,
    scheduleFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (frameId) => cancelAnimationFrame(frameId),
    now = () => performance.now(),
    onAgentRunError = () => {},
  }) {
    if (!store || !workspaceId || !sessionId || !agentRunId) throw new Error("chat controller identity is required");
    if (typeof initialCursor !== "string" || !initialCursor) throw new Error("initial stream cursor is invalid");
    if (!Number.isInteger(maxItemsPerFrame) || maxItemsPerFrame < 1) throw new Error("max items per frame is invalid");
    if (!Number.isFinite(reducerBudgetMs) || reducerBudgetMs <= 0) throw new Error("reducer budget is invalid");
    if (!Number.isInteger(queueHighWaterMark) || queueHighWaterMark < maxItemsPerFrame) throw new Error("queue high water mark is invalid");
    this.store = store;
    this.workspaceId = workspaceId;
    this.sessionId = sessionId;
    this.agentRunId = agentRunId;
    this.lastCursor = initialCursor;
    this.maxItemsPerFrame = maxItemsPerFrame;
    this.reducerBudgetMs = reducerBudgetMs;
    this.queueHighWaterMark = queueHighWaterMark;
    this.scheduleFrame = scheduleFrame;
    this.cancelFrame = cancelFrame;
    this.now = now;
    this.onAgentRunError = onAgentRunError;
    this.queue = [];
    this.queueOffset = 0;
    this.frameId = null;
    this.disposed = false;
    this.terminalAccepted = false;
    this.failure = null;
    this.idleWaiters = [];
    this.acceptedTelemetry = new WeakMap();
    this.acceptedOrdinal = 0;
  }

  accept(entry) {
    if (this.disposed) throw new Error("chat controller is disposed");
    if (this.failure) throw this.failure;
    if (this.terminalAccepted) throw new Error("session stream emitted an item after terminal");
    if (entry.item.agentRunId !== this.agentRunId) throw new Error("Session stream AgentRun binding mismatch");
    if (entry.cursor !== null) {
      if (typeof entry.cursor !== "string" || !entry.cursor) throw new Error("session stream cursor is invalid");
      this.lastCursor = entry.cursor;
    }
    this.terminalAccepted = entry.item.kind === "committed" && TERMINALS.has(entry.item.event.type);
    this.acceptedOrdinal += 1;
    this.acceptedTelemetry.set(entry, this.store.beginStreamTelemetry(entry, this.acceptedOrdinal));
    const previous = this.queue.length > this.queueOffset ? this.queue.at(-1) : undefined;
    if (canCoalesce(previous, entry)) this.queue[this.queue.length - 1] = entry;
    else this.queue.push(entry);
    this.ensureScheduled();
  }

  setCursor(cursor) {
    if (typeof cursor !== "string" || !cursor) throw new Error("resume cursor is invalid");
    if (this.hasQueuedItems()) throw new Error("cannot replace cursor while stream items are queued");
    this.lastCursor = cursor;
  }

  async acceptWithBackpressure(entry) {
    this.accept(entry);
    if (this.queuedItemCount() >= this.queueHighWaterMark) await this.whenIdle();
  }

  ensureScheduled() {
    if (this.frameId !== null || !this.hasQueuedItems() || this.disposed) return;
    this.frameId = this.scheduleFrame(() => this.drain());
  }

  hasQueuedItems() {
    return this.queueOffset < this.queue.length;
  }

  queuedItemCount() {
    return this.queue.length - this.queueOffset;
  }

  drain() {
    this.frameId = null;
    if (this.disposed) return;
    const startedAt = this.now();
    const batch = [];
    while (this.hasQueuedItems() && batch.length < this.maxItemsPerFrame) {
      batch.push(this.queue[this.queueOffset++]);
      if (this.now() - startedAt >= this.reducerBudgetMs) break;
    }
    if (batch.length) {
      try {
        const telemetry = batch.map((entry) => this.acceptedTelemetry.get(entry));
        this.store.applyStreamEntries(batch, telemetry);
        batch.forEach((entry) => this.acceptedTelemetry.delete(entry));
        const failed = [...batch].reverse().find((entry) => entry.item.kind === "committed" && entry.item.event.type === "agent_run_failed");
        if (failed) this.onAgentRunError(failed.item.event.payload);
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.queue = [];
        this.queueOffset = 0;
        this.rejectIdle(this.failure);
        return;
      }
    }
    if (this.hasQueuedItems()) this.ensureScheduled();
    else {
      this.queue = [];
      this.queueOffset = 0;
      this.resolveIdle();
    }
  }

  whenIdle() {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.hasQueuedItems() && this.frameId === null) return Promise.resolve();
    return new Promise((resolve, reject) => this.idleWaiters.push({ resolve, reject }));
  }

  resolveIdle() {
    this.idleWaiters.splice(0).forEach(({ resolve }) => resolve());
  }

  rejectIdle(error) {
    this.idleWaiters.splice(0).forEach(({ reject }) => reject(error));
  }

  dispose() {
    this.disposed = true;
    this.queue = [];
    this.queueOffset = 0;
    this.acceptedTelemetry = new WeakMap();
    this.failure = null;
    if (this.frameId !== null) this.cancelFrame(this.frameId);
    this.frameId = null;
    this.resolveIdle();
  }
}
