import { ApiError, apiResponse } from "../api";
import { readSse } from "./sessionEvents.ts";
import type { StreamEntry } from "./streamTypes.ts";
import type { WorkspaceChatController } from "./workspaceChatController.ts";

type ResumeState = {
  status: string;
  streamCursor: string;
};

type StreamWorkspaceAgentRunOptions = {
  controller: WorkspaceChatController;
  signal: AbortSignal;
  onConnection(connection: "running" | "reconnecting"): void;
  refreshResumeState(): Promise<ResumeState>;
};

function abortableDelay(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timeoutId = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function streamWorkspaceAgentRun({
  controller,
  signal,
  onConnection,
  refreshResumeState,
}: StreamWorkspaceAgentRunOptions) {
  while (!signal.aborted) {
    try {
      const response = await apiResponse(
        `/api/sessions/${controller.sessionId}/agent-runs/${controller.agentRunId}/events`,
        {
          signal,
          headers: controller.lastCursor !== "0-0" ? { "Last-Event-ID": controller.lastCursor } : {},
        },
      );
      onConnection("running");
      const terminal = await readSse(
        response,
        controller.agentRunId,
        (entry: StreamEntry) => controller.acceptWithBackpressure(entry),
        { signal },
      );
      await controller.whenIdle();
      if (terminal || signal.aborted) {
        return;
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (error instanceof ApiError && error.message === "agent_run_event_cursor_expired") {
        onConnection("reconnecting");
        const resumedAgentRun = await refreshResumeState();
        if (["completed", "failed", "cancelled"].includes(resumedAgentRun.status)) return;
        controller.setCursor(resumedAgentRun.streamCursor);
        continue;
      }
      if (!(error instanceof TypeError)) throw error;
    }
    onConnection("reconnecting");
    await abortableDelay(500, signal);
  }
}
