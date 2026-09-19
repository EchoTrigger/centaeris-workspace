import assert from "node:assert/strict";
import test from "node:test";
import { TranscriptContentReader } from "../../src/chat/transcriptContentReader.ts";

function source(text) {
  const bytes = new TextEncoder().encode(text);
  return async (offset) => {
    const start = Number(offset);
    let end = Math.min(start + 65536, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(start, end)),
      startOffset: offset, endOffset: String(end), hasMore: end < bytes.length };
  };
}

test("long Markdown loads automatically as one intact document across UTF-8 and fence boundaries", async () => {
  const text = `# Answer\n\n\`\`\`text\n${"中文abc".repeat(20000)}\n\`\`\`\n\n**Done**`;
  const reader = new TranscriptContentReader(source(text));
  await reader.loadAll();
  assert.equal(reader.getSnapshot().content, text);
  assert.equal(reader.getSnapshot().hasMore, false);
});

test("tool output appends ranges on demand and keeps earlier content readable", async () => {
  const totalBytes = 20 * 65536;
  const reader = new TranscriptContentReader(source("a".repeat(totalBytes)));
  await reader.loadMore();
  assert.equal(reader.getSnapshot().content.length, 65536);
  assert.equal(reader.getSnapshot().hasMore, true);
  while (reader.getSnapshot().hasMore) await reader.loadMore();
  assert.equal(reader.getSnapshot().content.length, totalBytes);
  assert.equal(reader.getSnapshot().hasMore, false);
});

test("disposing a view rejects late content even when the transport ignores cancellation", async () => {
  let resolve;
  const reader = new TranscriptContentReader(() => new Promise((done) => { resolve = done; }));
  const pending = reader.loadMore();
  reader.dispose();
  resolve({ content: "old session", startOffset: "0", endOffset: "11", hasMore: false });
  await pending;
  assert.equal(reader.getSnapshot().content, "");
});

test("failed continuation can retry without duplicating text", async () => {
  const text = "a".repeat(70000);
  const read = source(text);
  let fail = true;
  const reader = new TranscriptContentReader(async (offset) => {
    if (offset !== "0" && fail) { fail = false; throw Error("unavailable"); }
    return read(offset);
  });
  await reader.loadAll();
  assert.equal(reader.getSnapshot().error, true);
  const loadedBefore = reader.getSnapshot().content;
  await reader.retry();
  await reader.loadAll();
  assert.equal(reader.getSnapshot().content, text);
  assert.equal(reader.getSnapshot().error, false);
  assert.ok(reader.getSnapshot().content.startsWith(loadedBefore));
});
