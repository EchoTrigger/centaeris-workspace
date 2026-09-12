const { test, expect } = require("@playwright/test");
const { previewPdf } = require("./fixtures/preview-pdf");

for (const extension of ["docx", "pptx", "md"]) {
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
      const reader = page.locator(".libraryMarkdownPreview");
      await expect(page.getByRole("heading", { name: "中文审查" })).toBeVisible();
      await expect(reader).toContainText("住宿每晚 680 元。");
      await expect(reader.locator("script")).toHaveCount(0);
      await expect(reader).toHaveCSS("border-top-width", "0px");
      await expect(reader).toHaveCSS("box-shadow", "none");
      await expect(page.locator(".libraryPreviewBody")).toHaveClass(/isMarkdown/);
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
      await expect(page.getByRole("img", { name: /中文审查.*2/ })).toBeVisible();
      await expect(page.getByRole("button", { name: "下一页", exact: true })).toHaveCount(0);
      await expect(page.locator("iframe")).toHaveCount(0);
    }
  });
}

test("library xlsx opens as a structured workbook and keeps print view", async ({ page }) => {
  const item = { id: "file_1", objectKind: "file", status: "ready", displayName: "差旅预算.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  const workbook = {
    schema: "knowledge.workbook_preview.v1",
    styles: [{ font: { bold: true, italic: false, color: "#FFFFFF" }, fill: "#1F4E78", horizontal: "center",
      vertical: "center", wrapText: true, borders: { bottom: { style: "thin", color: "#000000" } } }],
    sheets: [{ name: "预算", state: "visible", maxRow: 3, maxColumn: 3, frozenPane: "B2",
      columns: [{ index: 2, widthPx: 180, hidden: false }], merges: [{ startRow: 1, startColumn: 1, endRow: 1, endColumn: 3 }],
      rows: [
        { index: 1, heightPx: 38, hidden: false, cells: [{ column: 1, displayValue: "差旅预算", kind: "text", formula: null, numberFormat: "General", styleId: 0 }] },
        { index: 2, heightPx: null, hidden: false, cells: [{ column: 1, displayValue: "项目", kind: "text", formula: null, numberFormat: "General", styleId: 0 }, { column: 2, displayValue: "金额", kind: "text", formula: null, numberFormat: "General", styleId: 0 }] },
        { index: 3, heightPx: null, hidden: false, cells: [{ column: 1, displayValue: "住宿", kind: "text", formula: null, numberFormat: "General", styleId: 0 }, { column: 2, displayValue: "680", kind: "number", formula: null, numberFormat: "¥#,##0.00", styleId: 0 }] },
      ] }],
  };
  await page.route("http://localhost:8000/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses = {
      "/api/me": { user: { id: "user_1", email: "member@example.com" } },
      "/api/workspaces": { workspaces: [{ id: "ws_1", name: "Default", role: "owner" }] },
      "/api/workspaces/ws_1/agents": { agents: [] },
      "/api/library": { objects: [item] },
      "/api/library/file_1": { object: item },
    };
    if (path === "/api/spreadsheet-preview/userLibraryObject/file_1") return route.fulfill({ json: workbook });
    if (path === "/api/office-preview/userLibraryObject/file_1") return route.fulfill({ contentType: "application/pdf", body: previewPdf() });
    return responses[path] ? route.fulfill({ json: responses[path] }) : route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.goto("/w/ws_1/library/file_1");
  await expect(page.getByRole("grid", { name: "预算" })).toBeVisible();
  await expect(page.getByRole("gridcell", { name: "差旅预算" })).toHaveAttribute("colspan", "3");
  await expect(page.getByRole("gridcell", { name: "¥680.00" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "预算" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "打印视图" }).click();
  await expect(page.getByRole("img", { name: "差旅预算.xlsx，第 1 页" })).toBeVisible();
  await page.getByRole("button", { name: "表格视图" }).click();
  await expect(page.getByRole("grid", { name: "预算" })).toBeVisible();
  await expect(page.locator('a[href="http://localhost:8000/api/library/file_1/download"]')).toBeVisible();
});

test("office pages render as one borderless vertical document flow", async ({ page }) => {
  await openPreview(page, (route) => route.fulfill({ contentType: "application/pdf", body: previewPdf() }));

  const pages = page.locator(".officePreviewPage");
  await expect(pages).toHaveCount(2);
  await expect(page.getByRole("img", { name: "test.docx，第 1 页", exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "test.docx，第 2 页", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "上一页", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "下一页", exact: true })).toHaveCount(0);
  await expect(pages.first()).toHaveCSS("box-shadow", "none");
  await expect(page.locator(".officePreviewDocument")).toHaveCSS("gap", "0px");
  const viewport = page.locator(".officePreviewViewport");
  await expect.poll(() => viewport.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test("library previews source code as read-only highlighted text", async ({ page }) => {
  const item = {
    id: "file_1",
    objectKind: "file",
    status: "ready",
    displayName: "WorkspaceContextPanel.tsx",
    contentType: "application/octet-stream",
  };
  const source = "export function Preview() {\n  return <aside>code preview</aside>;\n}\n";
  await page.route("http://localhost:8000/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses = {
      "/api/me": { user: { id: "user_1", email: "member@example.com" } },
      "/api/workspaces": { workspaces: [{ id: "ws_1", name: "Default", role: "owner" }] },
      "/api/workspaces/ws_1/agents": { agents: [] },
      "/api/library": { objects: [item] },
      "/api/library/file_1": { object: item },
    };
    if (path === "/api/library/file_1/preview") {
      return route.fulfill({ contentType: "text/plain; charset=utf-8", body: source });
    }
    return responses[path]
      ? route.fulfill({ json: responses[path] })
      : route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/library/file_1");

  const preview = page.getByRole("region", { name: "WorkspaceContextPanel.tsx" });
  await expect(preview.locator(".cm-editor")).toBeVisible();
  await expect(preview.locator(".cm-content")).toContainText("code preview");
  await expect(preview.locator(".cm-line span").first()).toBeVisible();
  await expect(preview.locator("textarea")).toHaveCount(0);
  await expect(preview).toHaveClass(/libraryCodePreview/);
  await expect(preview).toHaveCSS("border-top-width", "0px");
  await expect(preview).toHaveCSS("box-shadow", "none");
  await expect(page.locator(".libraryPreviewBody")).toHaveClass(/isCode/);
  await expect(page.locator('a[href="http://localhost:8000/api/library/file_1/download"]')).toBeVisible();
});

for (const sample of [
  { extension: "go", contentType: "text/x-go", source: 'package main\nfunc main() { println("hello") }\n' },
  { extension: "php", contentType: "application/x-httpd-php", source: '<?php\nfunction hello(): string { return "hello"; }\n' },
  { extension: "yaml", contentType: "application/yaml", source: "name: preview\nenabled: true\n" },
  { extension: "xml", contentType: "application/xml", source: '<preview enabled="true">code</preview>\n' },
]) {
  test(`library syntax-highlights ${sample.extension} instead of silently using plain text`, async ({ page }) => {
    const item = {
      id: "file_1",
      objectKind: "file",
      status: "ready",
      displayName: `preview.${sample.extension}`,
      contentType: sample.contentType,
    };
    await page.route("http://localhost:8000/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const responses = {
        "/api/me": { user: { id: "user_1", email: "member@example.com" } },
        "/api/workspaces": { workspaces: [{ id: "ws_1", name: "Default", role: "owner" }] },
        "/api/workspaces/ws_1/agents": { agents: [] },
        "/api/library": { objects: [item] },
        "/api/library/file_1": { object: item },
      };
      if (path === "/api/library/file_1/preview") {
        return route.fulfill({ contentType: "text/plain; charset=utf-8", body: sample.source });
      }
      return responses[path]
        ? route.fulfill({ json: responses[path] })
        : route.fulfill({ status: 404, json: { error: "not_found" } });
    });

    await page.goto("/w/ws_1/library/file_1");

    const preview = page.getByRole("region", { name: `preview.${sample.extension}` });
    await expect(preview).toHaveAttribute("data-language", sample.extension);
    await expect(preview.locator(".cm-line span").first()).toBeVisible();
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
