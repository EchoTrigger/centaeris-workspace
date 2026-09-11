const { test, expect } = require("@playwright/test");
const { previewPdf } = require("./fixtures/preview-pdf");

for (const extension of ["docx", "xlsx", "pptx", "md"]) {
  test(`library previews ${extension} and preserves original download`, async ({ page }) => {
    const item = { id: "file_1", objectKind: "file", status: "ready", displayName: `中文审查.${extension}`,
      contentType: extension === "md" ? "text/markdown" : "application/octet-stream" };
    await page.route("http://localhost:8000/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const responses = {
        "/api/me": { user: { id: "user_1", email: "member@example.com" } },
        "/api/workspaces": { workspaces: [{ id: "ws_1", name: "Default", role: "owner" }] },
        "/api/workspaces/ws_1/agents": { agents: [] },
        "/api/library": { objects: [item] },
        "/api/library/file_1": { object: item },
      };
      if (path === "/api/library/file_1/preview") return route.fulfill({ contentType: "text/markdown; charset=utf-8", body: "# 中文审查\n\n住宿每晚 680 元。\n\n<script>alert(1)</script>" });
      if (path === "/api/office-preview/userLibraryObject/file_1") return route.fulfill({ contentType: "application/pdf", body: previewPdf() });
      return responses[path] ? route.fulfill({ json: responses[path] }) : route.fulfill({ status: 404, json: { error: "not_found" } });
    });
    await page.goto("/w/ws_1/library/file_1");
    await expect(page.locator('a[href="http://localhost:8000/api/library/file_1/download"]')).toBeVisible();
    if (extension === "md") {
      await expect(page.getByRole("heading", { name: "中文审查" })).toBeVisible();
      await expect(page.locator(".documentTextPreview")).toContainText("住宿每晚 680 元。");
      await expect(page.locator(".documentTextPreview script")).toHaveCount(0);
    } else {
      const canvas = page.getByRole("img", { name: /中文审查.*1/ });
      await expect(canvas).toBeVisible();
      await expect.poll(() => canvas.evaluate((element) => {
        const pixels = element.getContext("2d").getImageData(0, 0, element.width, element.height).data;
        let dark = 0, light = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] && pixels[i] < 100) dark++;
          if (pixels[i] > 240 && pixels[i + 3]) light++;
        }
        return dark > 100 && light > 10000;
      })).toBe(true);
      await page.getByRole("button", { name: "下一页", exact: true }).click();
      await expect(page.getByRole("img", { name: /中文审查.*2/ })).toBeVisible();
      await expect(page.locator("iframe")).toHaveCount(0);
    }
  });
}

async function openPreview(page, respond) {
  const item = { id: "file_1", objectKind: "file", status: "ready", displayName: "test.docx", contentType: "application/octet-stream" };
  await page.route("http://localhost:8000/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/office-preview/userLibraryObject/file_1") return respond(route);
    const responses = {
      "/api/me": { user: { id: "user_1", email: "member@example.com" } },
      "/api/workspaces": { workspaces: [{ id: "ws_1", name: "Default", role: "owner" }] },
      "/api/workspaces/ws_1/agents": { agents: [] },
      "/api/library": { objects: [item] },
      "/api/library/file_1": { object: item },
    };
    return responses[path] ? route.fulfill({ json: responses[path] }) : route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.goto("/w/ws_1/library/file_1");
}

test("pending preview becomes painted PDF without navigating an iframe", async ({ page }) => {
  let requests = 0;
  await openPreview(page, (route) => ++requests === 1
    ? route.fulfill({ status: 202, contentType: "text/html", body: "pending" })
    : route.fulfill({ contentType: "application/pdf", body: previewPdf() }));
  await expect(page.getByRole("status").filter({ hasText: "正在生成预览" })).toBeVisible();
  await expect(page.getByRole("img", { name: "test.docx，第 1 页", exact: true })).toBeVisible();
  expect(requests).toBe(2);
});

for (const failure of ["conversion", "invalid-pdf", "login"]) {
  test(`preview exposes ${failure} failure and can reload`, async ({ page }) => {
    let recovered = false;
    await openPreview(page, (route) => recovered ? route.fulfill({ contentType: "application/pdf", body: previewPdf() })
      : failure === "conversion" ? route.fulfill({ status: 503, json: { error: "office_preview_task_invalid" } })
      : route.fulfill({ contentType: failure === "login" ? "text/html" : "application/pdf", body: "invalid" }));
    await expect(page.getByRole("alert")).toContainText("无法显示预览");
    await expect(page.locator('a[href$="/file_1/download"]')).toBeVisible();
    recovered = true;
    await page.getByRole("button", { name: "重新加载预览", exact: true }).click();
    await expect(page.getByRole("img", { name: "test.docx，第 1 页", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}

test("pending preview times out and stops polling", async ({ page }) => {
  await page.clock.install();
  let requests = 0;
  await openPreview(page, (route) => { requests++; return route.fulfill({ status: 202, body: "pending" }); });
  await expect.poll(() => requests).toBeGreaterThan(0);
  await page.clock.fastForward(120_001);
  await expect(page.getByRole("alert")).toContainText("预览等待超时");
  const stopped = requests;
  await page.clock.fastForward(10_000);
  expect(requests).toBe(stopped);
});

test("leaving a pending preview cancels polling", async ({ page }) => {
  await page.clock.install();
  let requests = 0;
  await openPreview(page, (route) => { requests++; return route.fulfill({ status: 202, body: "pending" }); });
  await expect.poll(() => requests).toBeGreaterThan(0);
  await page.getByRole("button", { name: "资料库", exact: true }).click();
  await expect(page.getByRole("heading", { name: "库", exact: true })).toBeVisible();
  const stopped = requests;
  await page.clock.fastForward(10_000);
  expect(requests).toBe(stopped);
});

test("small spreadsheet print text can be enlarged and returned to fit width", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 800 });
  await openPreview(page, (route) => route.fulfill({ contentType: "application/pdf", body: previewPdf() }));
  const canvas = page.getByRole("img", { name: "test.docx，第 1 页", exact: true });
  await expect(canvas).toBeVisible();
  const initial = await canvas.boundingBox();
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await expect.poll(async () => (await canvas.boundingBox())?.width || 0).toBeGreaterThan(initial.width * 1.2);
  await page.getByRole("button", { name: "适合宽度", exact: true }).click();
  await expect.poll(async () => Math.abs(((await canvas.boundingBox())?.width || 0) - initial.width)).toBeLessThan(1);
});

test("a scrollable page stays painted without scrollbar-driven flicker", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  await openPreview(page, (route) => route.fulfill({ contentType: "application/pdf", body: previewPdf() }));
  // Exercise classic, space-consuming scrollbars, as in the desktop browser.
  await page.addStyleTag({ content: ".officePreviewViewport::-webkit-scrollbar { width: 16px; height: 16px; }" });
  const canvas = page.getByRole("img", { name: "test.docx，第 1 页", exact: true });
  await expect(canvas).toBeVisible();
  const unstableFrames = await canvas.evaluate(async (element) => {
    let unstable = 0;
    const width = element.getBoundingClientRect().width;
    for (let frame = 0; frame < 60; frame++) {
      await new Promise(requestAnimationFrame);
      if (getComputedStyle(element).display === "none" || getComputedStyle(element).visibility === "hidden"
        || element.getBoundingClientRect().width !== width) unstable++;
    }
    return unstable;
  });
  expect(unstableFrames).toBe(0);
});

test("resizing a displayed preview never blanks the existing page", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 480 });
  await openPreview(page, (route) => route.fulfill({ contentType: "application/pdf", body: previewPdf() }));
  const canvas = page.getByRole("img", { name: "test.docx，第 1 页", exact: true });
  await expect(canvas).toBeVisible();
  await canvas.evaluate((element) => {
    window.previewBlankFrames = 0;
    window.previewObserver = new MutationObserver(() => {
      if (!element.getBoundingClientRect().width || getComputedStyle(element).visibility === "hidden") window.previewBlankFrames++;
    });
    window.previewObserver.observe(element, { attributes: true });
  });
  const initial = await canvas.boundingBox();
  await page.setViewportSize({ width: 800, height: 480 });
  await expect.poll(async () => (await canvas.boundingBox())?.width || 0).toBeLessThan(initial.width - 50);
  await expect(canvas).toBeVisible();
  const blanks = await page.evaluate(() => { window.previewObserver.disconnect(); return window.previewBlankFrames; });
  expect(blanks).toBe(0);
});
