const { test, expect } = require("@playwright/test");

test("live labels sweep once, remain readable, and respect motion and contrast preferences", async ({ page }) => {
  await page.goto("/tests/fixtures/reasoning.html");
  await page.evaluate(() => window.reasoningFixture.liveSnapshot(1, "Inspect inputs"));
  const label = page.locator(".workspaceReasoning button > span").first();
  await expect(label).toHaveCSS("animation-name", "statusShimmerSweep");
  await expect(label).toHaveCSS("animation-iteration-count", "1");
  await expect(label).toHaveCSS("animation-duration", "4s");
  await label.evaluate((node) => node.getAnimations().forEach((animation) => animation.finish()));
  await expect(label).toHaveCSS("background-color", "rgb(107, 107, 107)");
  await expect(label).toHaveText("Thinking");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await expect(label).toHaveCSS("background-color", "rgb(160, 160, 160)");
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(label).toHaveCSS("animation-name", "none");
  await expect(label).toHaveCSS("-webkit-text-fill-color", "rgb(107, 107, 107)");
  await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "active" });
  await expect(label).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ forcedColors: "none" });
  await page.evaluate(() => window.reasoningFixture.committedHistory());
  await expect(label).toHaveCSS("animation-name", "none");
  await expect(label).toHaveText("Thoughts");
});

test("live tool status uses the same sweep and disappears when the run completes", async ({ page }) => {
  await page.goto("/tests/fixtures/reasoning.html");
  await page.evaluate(() => window.reasoningFixture.reconnect());
  const label = page.locator(".workspaceLiveStatusText");
  await expect(label).toHaveCSS("animation-name", "statusShimmerSweep");
  await page.evaluate(() => window.reasoningFixture.complete());
  await expect(label).toHaveCount(0);
  await expect(page.locator(".statusShimmer")).toHaveCount(0);
});

test("reasoning shows running only while collapsed and live, and keeps its preview after completion", async ({ page }) => {
  await page.goto("/tests/fixtures/reasoning.html");
  await page.evaluate(() => window.reasoningFixture.liveSnapshot(1, "Inspect **inputs**"));
  const toggle = page.locator(".workspaceReasoning button");
  await expect(toggle).toHaveAttribute("aria-label", "Thinking");
  await expect(toggle.locator(":scope > span").first()).toHaveText("Thinking");
  await expect(page.locator(".reasoningPreviewText")).toHaveText("Inspect inputs");
  await page.evaluate(() => window.reasoningFixture.liveSnapshot(2, "Inspect **inputs**\nlatest fragment"));
  await expect(page.locator(".reasoningPreviewText")).toContainText("latest fragment");
  await toggle.click();
  await expect(toggle).toHaveText("Thoughts");
  await expect(page.locator(".reasoningPreviewText")).toHaveCount(0);
  await page.evaluate(() => { window.reasoningFixture.liveSnapshot(3, "More thinking"); window.reasoningFixture.remount(); });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".workspaceReasoningBody")).toHaveText("More thinking");
  await page.evaluate(() => window.reasoningFixture.committedHistory());
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveText("Thoughts");
  await expect(page.locator(".workspaceReasoning")).toHaveCount(1);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", "Thoughts");
  await expect(page.locator(".reasoningPreviewText")).toHaveText("Committed thinking");
});

test("interrupted reasoning keeps its collapsed preview and expands under the thinking label", async ({ page }) => {
  await page.goto("/tests/fixtures/reasoning.html");
  await page.evaluate(() => window.reasoningFixture.committedHistory("interrupted"));
  const toggle = page.locator(".workspaceReasoning button");
  await expect(toggle).toHaveAttribute("aria-label", "Thoughts");
  await expect(page.locator(".reasoningPreviewText")).toHaveText("Committed thinking");
  await toggle.click();
  await expect(toggle).toHaveText("Thoughts");
  await expect(page.locator(".reasoningPreviewText")).toHaveCount(0);
  await expect(page.locator(".workspaceReasoningBody")).toHaveText("Committed thinking");
});

test("committed history renders thinking before its answer and preserves disclosure on reload", async ({ page }) => {
  await page.goto("/tests/fixtures/reasoning.html");
  await page.evaluate(() => window.reasoningFixture.committedHistory());
  const toggle = page.locator(".workspaceReasoning button");
  await toggle.click();
  await expect(page.getByText("Committed thinking", { exact: true })).toBeVisible();
  await expect(page.getByText("Committed answer", { exact: true })).toBeVisible();
  const before = await page.getByText("Committed thinking", { exact: true }).boundingBox();
  const after = await page.getByText("Committed answer", { exact: true }).boundingBox();
  expect(before.y).toBeLessThan(after.y);
  await page.evaluate(() => { window.reasoningFixture.committedHistory(); window.reasoningFixture.remount(); });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".workspaceReasoning")).toHaveCount(1);
});

test("long reasoning uses a bounded keyboard-scrollable region and the shared text font", async ({ page }) => {
  await page.goto("/tests/fixtures/reasoning.html");
  await page.evaluate(() => window.reasoningFixture.longContent());
  await page.locator(".workspaceReasoning button").click();
  const body = page.locator(".workspaceReasoningBody");
  await expect(body).toHaveAttribute("tabindex", "0");
  const geometry = await body.evaluate((node) => ({ height: node.clientHeight, scrollHeight: node.scrollHeight }));
  expect(geometry.height).toBeLessThanOrEqual(360);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.height);
  await body.focus();
  await page.keyboard.press("PageDown");
  await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  const fonts = await page.evaluate(() => [document.body, document.querySelector(".workspaceReasoning button"), document.querySelector(".workspaceReasoningBody p")].map((node) => getComputedStyle(node).fontFamily));
  expect(new Set(fonts).size).toBe(1);
  expect(fonts[0]).toMatch(/^"Noto Sans CJK SC"/);
});

test("reasoning and tools keep their order and independent disclosures across updates and remount", async ({ page }) => {
  await page.goto("/tests/fixtures/reasoning.html");
  const blocks = page.locator(".workspaceReasoning");
  await expect(blocks).toHaveCount(2);
  await expect(page.locator(".workspaceLiveStatus")).toHaveCount(0);
  await page.evaluate(() => window.reasoningFixture.reconnect());
  await expect(page.locator(".workspaceLiveStatus")).toContainText("Reconnecting");
  await page.evaluate(() => window.reasoningFixture.resume());
  await expect(page.locator(".workspaceLiveStatus")).toHaveCount(0);
  const first = blocks.first().getByRole("button");
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".reasoningPreviewText").first()).toHaveText("Inspect inputs");
  await expect(page.locator(".workspaceReasoningBody")).toHaveCount(0);
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Inspect inputs", { exact: true })).toBeVisible();
  const tool = page.getByRole("button", { name: "Read files", exact: true }).first();
  await tool.click();
  await page.evaluate(() => window.reasoningFixture.complete());
  await expect(first).toHaveText("Thoughts");
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Inspect inputs and constraints", { exact: true })).toBeVisible();
  await expect(blocks.last().getByRole("button")).toHaveAttribute("aria-expanded", "false");
  await expect(tool).toHaveAttribute("aria-expanded", "true");
  const order = await page.locator(".workspaceReasoning, .workspaceActivityGroupRecord").evaluateAll((nodes) => nodes.map((node) => node.classList.contains("workspaceReasoning") ? "reasoning" : "tool"));
  expect(order).toEqual(["tool", "reasoning", "tool", "reasoning"]);
  await page.evaluate(() => window.reasoningFixture.remount());
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await expect(tool).toHaveAttribute("aria-expanded", "true");
  await first.focus();
  await page.keyboard.press("Space");
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".workspaceReasoningBody").getByText("Inspect inputs and constraints", { exact: true })).toHaveCount(0);
  await expect(first.locator(".reasoningPreviewText")).toHaveText("Inspect inputs and constraints");
});



test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("centaeris:language:v1", "en"));
});
test("live reasoning follows latest, detaches on scrolling, and resumes at bottom or reopening", async ({ page }) => {
  await page.goto("/tests/fixtures/reasoning.html");
  const content = (count) => Array.from({ length: count }, (_, i) => `Paragraph ${i + 1}: inspect inputs and constraints.`).join("\n\n");
  await page.evaluate((text) => window.reasoningFixture.liveSnapshot(1, text), content(40));
  const toggle = page.locator(".workspaceReasoning button").first();
  await toggle.click();
  const body = page.locator(".workspaceReasoningBody");
  const gap = () => body.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
  await expect.poll(gap).toBeLessThanOrEqual(2);
  await page.evaluate((text) => window.reasoningFixture.liveSnapshot(2, text), content(50));
  await expect(body).toContainText("Paragraph 50:");
  await expect.poll(gap).toBeLessThanOrEqual(2);
  await body.hover();
  await page.mouse.wheel(0, -250);
  await expect.poll(gap).toBeGreaterThan(100);
  // Wait for the wheel gesture to settle before checking that new text preserves position.
  await page.waitForTimeout(200);
  const detachedTop = await body.evaluate((node) => node.scrollTop);
  await page.evaluate((text) => window.reasoningFixture.liveSnapshot(3, text), content(60));
  await expect(body).toContainText("Paragraph 60:");
  await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBe(detachedTop);
  await body.focus();
  await page.keyboard.press("Control+End");
  await expect.poll(gap).toBeLessThanOrEqual(2);
  await page.evaluate((text) => window.reasoningFixture.liveSnapshot(4, text), content(70));
  await expect(body).toContainText("Paragraph 70:");
  await expect.poll(gap).toBeLessThanOrEqual(2);
  await page.keyboard.press("Control+Home");
  await expect.poll(gap).toBeGreaterThan(100);
  await toggle.click();
  await toggle.click();
  await expect.poll(gap).toBeLessThanOrEqual(2);
});
