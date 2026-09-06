const { test, expect } = require("@playwright/test");

test("live collapsed preview follows the latest text, expansion keeps the running label and seal keeps disclosure", async ({ page }) => {
  await page.goto("/tests/fixtures/reasoning.html");
  await page.evaluate(() => window.reasoningFixture.liveSnapshot(1, "Inspect **inputs**"));
  const toggle = page.locator(".workspaceReasoning button");
  await expect(toggle).toHaveAttribute("aria-label", "正在思考");
  await expect(page.locator(".reasoningPreviewText")).toHaveText("Inspect inputs");
  await page.evaluate(() => window.reasoningFixture.liveSnapshot(2, "Inspect **inputs**\nlatest fragment"));
  await expect(page.locator(".reasoningPreviewText")).toContainText("latest fragment");
  await toggle.click();
  await expect(toggle).toHaveText("正在思考");
  await expect(page.locator(".reasoningPreviewText")).toHaveCount(0);
  await page.evaluate(() => { window.reasoningFixture.liveSnapshot(3, "More thinking"); window.reasoningFixture.remount(); });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".workspaceReasoningBody")).toHaveText("More thinking");
  await page.evaluate(() => window.reasoningFixture.committedHistory());
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveText("思考");
  await expect(page.locator(".workspaceReasoning")).toHaveCount(1);
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
  await expect(first).toHaveText("思考");
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
  await expect(page.getByText("Inspect inputs and constraints", { exact: true })).toHaveCount(0);
});
