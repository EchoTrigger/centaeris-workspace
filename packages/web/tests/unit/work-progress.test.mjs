import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createInstance } from "i18next";
import { formatWorkDuration } from "../../src/chat/workDuration.ts";
import { groupTranscriptTurns, shouldLoadEarlier } from "../../src/chat/transcriptTurns.ts";

test("work duration is localized and never pads or prints zero units", async () => {
  const i18n = createInstance();
  const resources = Object.fromEntries(["en", "zh-CN"].map((language) => [language, {
    translation: JSON.parse(readFileSync(new URL(`../../src/locales/${language}.json`, import.meta.url), "utf8")),
  }]));
  await i18n.init({ resources, lng: "zh-CN", keySeparator: false });
  assert.equal(formatWorkDuration(0, i18n.t.bind(i18n)), "");
  assert.equal(formatWorkDuration(80_000, i18n.t.bind(i18n)), "1分 20秒");
  assert.equal(formatWorkDuration(3_601_000, i18n.t.bind(i18n)), "1时 1秒");
  await i18n.changeLanguage("en");
  assert.equal(formatWorkDuration(80_000, i18n.t.bind(i18n)), "1m 20s");
});

test("only a new user message starts a work period; supplements stay in its process", () => {
  const blocks = [
    ["user-a", "userText"], ["reason", "reasoning"], ["extra", "notice"],
    ["tool", "tool"], ["answer", "assistantText"], ["user-b", "userText"],
  ].map(([blockId, kind]) => ({ blockId, body: { kind } }));
  assert.deepEqual(groupTranscriptTurns(blocks.map(b => b.blockId), id => blocks.find(b => b.blockId === id)), [
    { id: "user-a", userBlockId: "user-a", processIds: ["reason", "extra", "tool"], answerIds: ["answer"] },
    { id: "user-b", userBlockId: "user-b", processIds: [], answerIds: [] },
  ]);
});

test("upward intent loads at the top even when no scroll event can fire", () => {
  assert.equal(shouldLoadEarlier(0, true, false), true);
  assert.equal(shouldLoadEarlier(179, true, false), true);
  assert.equal(shouldLoadEarlier(181, true, false), false);
  assert.equal(shouldLoadEarlier(0, false, false), false);
  assert.equal(shouldLoadEarlier(0, true, true), false);
});
