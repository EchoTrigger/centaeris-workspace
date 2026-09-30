import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { configureApi } from "../../src/api";
import { TranscriptReferencedContent } from "../../src/chat/TranscriptReferencedContent";
import { TranscriptContentReader } from "../../src/chat/transcriptContentReader";
import { clearTranscriptContentRangeCache } from "../../src/chat/transcriptContentRanges";
import { watchTranscriptLoads } from "../helpers/transcript-reader-watchdog.mjs";

const results: { name: string; actual: unknown; expected: unknown }[] = [];
const check = (name: string, actual: unknown, expected: unknown) => results.push({ name, actual, expected });
const host = document.getElementById("host")!;
const root = createRoot(host);
const watcher = watchTranscriptLoads(TranscriptContentReader);
const requests: { url: URL; signal: AbortSignal; resolve: (response: Response) => void; reject: (error: Error) => void }[] = [];
const originalFetch = window.fetch;
configureApi({ apiBaseUrl: location.origin });
window.fetch = (input, init) => new Promise((resolve, reject) => {
  requests.push({ url: new URL(String(input)), signal: init!.signal as AbortSignal, resolve, reject });
});
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(predicate: () => boolean) {
  for (let turn = 0; turn < 100; turn++) {
    if (predicate()) return;
    await settle();
  }
  throw new Error("bounded component settlement timed out");
}
function render(refId: string) {
  flushSync(() => root.render(<StrictMode><TranscriptReferencedContent
    sessionId="test-session" projectionGeneration="generation-1"
    reference={{ refId, revision: "1", byteLength: "8" }} mode="plain" />
  </StrictMode>));
}
function complete(request: typeof requests[number], content: string) {
  request.resolve(Response.json({
    schema: "transcript.content.range.v1", sessionId: "test-session",
    projectionVersion: "transcript.projection.v1", projectionGeneration: "generation-1",
    refId: request.url.searchParams.get("refId"), revision: "1", byteLength: "8",
    startOffset: "0", endOffset: "8", content, hasMore: false,
  }));
}
try {
  render("unmount");
  await until(() => requests.length >= 2);
  check("StrictMode cancels the replaced effect", requests[0].signal.aborted, true);
  flushSync(() => root.render(null));
  check("unmount aborts the pending page", requests[1].signal.aborted, true);
  for (const request of requests) request.reject(new DOMException("Aborted", "AbortError"));
  await Promise.all(watcher.operations.map(operation => operation.pending));
  check("unmounted loadAll promises finish without spinning", watcher.operations.map(operation => operation.error), [null, null]);
  check("unmount leaves no content", host.textContent, "");

  const oldStart = requests.length;
  render("old-reference");
  await until(() => requests.length >= oldStart + 2);
  render("new-reference");
  await until(() => requests.length >= oldStart + 3);
  const oldRequests = requests.slice(oldStart, oldStart + 2);
  check("reference change aborts the old page", oldRequests.every(request => request.signal.aborted), true);
  complete(requests.at(-1)!, "new view");
  await until(() => host.textContent === "new view");
  for (const request of oldRequests) complete(request, "old view");
  await Promise.all(watcher.operations.map(operation => operation.pending));
  check("late old pages cannot contaminate the new view", host.textContent, "new view");
  check("reference-change loadAll promises finish without spinning", watcher.operations.slice(2).map(operation => operation.error), [null, null, null]);
} catch (error) {
  check("component exception", String(error), "no exception");
} finally {
  root.unmount();
  watcher.restore();
  window.fetch = originalFetch;
  clearTranscriptContentRangeCache();
}
document.getElementById("results")!.textContent = JSON.stringify(results);
