const { test, expect } = require("@playwright/test");

test("draft attachment squares retain local image URLs without uploading or creating a session", async ({ page }, testInfo) => {
  const writes = [];
  await page.addInitScript(() => {
    window.attachmentUrls = { created: [], revoked: [] };
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (file) => {
      const url = create(file);
      window.attachmentUrls.created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      window.attachmentUrls.revoked.push(url);
      revoke(url);
    };
  });
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") writes.push(request.url());
    const responses = {
      "/api/me": { user: { id: "1", email: "member@example.com", isStaff: false } },
      "/api/workspaces": { workspaces: [{ id: "ws_1", name: "默认工作区", status: "active", role: "owner" }] },
      "/api/workspaces/ws_1/agents": { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", avatarKind: "centaeris", status: "active", deletedAt: null }] },
      "/api/models": { models: [{ id: "model_1", displayName: "Clinical", provider: "fake", modelName: "fake-model" }] },
      "/api/workspaces/ws_1/session-projects": { projects: [] },
      "/api/workspaces/ws_1/sessions": { sessions: [] },
    };
    const response = responses[new URL(request.url()).pathname];
    await route.fulfill(response ? { json: response } : { status: 404, json: { error: "not_found" } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/w/ws_1/agents/centaeris");
  await page.getByLabel("选择一个或多个材料").setInputFiles([
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") },
    { name: "long-filename-that-must-stop-after-two-lines.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") },
    { name: "photo.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="blue"/></svg>') },
    { name: "broken.png", mimeType: "image/png", buffer: Buffer.from("not an image") },
  ]);
  const cards = page.locator(".workspaceComposerAttachments .attachmentCard");
  await expect(cards).toHaveCount(4);
  for (const card of await cards.all()) {
    await expect(card).toHaveCSS("width", "84px");
    await expect(card).toHaveCSS("height", "84px");
  }
  await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();
  await expect(page.locator(".attachmentCardName").last()).toHaveCSS("-webkit-line-clamp", "2");
  const image = page.getByRole("button", { name: "预览 photo.svg", exact: true });
  await expect(image).toHaveAttribute("title", "photo.svg");
  await expect(image.locator("img")).toBeVisible();
  await expect(image).not.toContainText("photo.svg");
  const source = await image.locator("img").getAttribute("src");
  expect(source).toMatch(/^blob:/);
  await expect(page.getByRole("button", { name: "预览 broken.png", exact: true })).toContainText("图片不可用");
  for (const remove of await page.locator(".attachmentCardRemove").all()) {
    expect(await remove.evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + 2));
    })).toBe(true);
  }
  const screenshot = testInfo.outputPath("attachment-cards.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("attachment-cards", { path: screenshot, contentType: "image/png" });
  const created = await page.evaluate(() => window.attachmentUrls.created.length);
  await page.getByRole("textbox", { name: "输入消息", exact: true }).fill("rerender the composer");
  await page.getByRole("button", { name: "从本条消息移除 notes.txt", exact: true }).click();
  await expect(image.locator("img")).toHaveAttribute("src", source);
  expect(await page.evaluate(() => window.attachmentUrls.created.length)).toBe(created);
  await image.click();
  const dialog = page.getByRole("dialog", { name: "预览 photo.svg", exact: true });
  await expect(dialog.locator("img")).toHaveAttribute("src", source);
  await dialog.getByRole("button", { name: "关闭预览", exact: true }).press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "从本条消息移除 photo.svg", exact: true }).click();
  await expect.poll(() => page.evaluate((url) => window.attachmentUrls.revoked.includes(url), source)).toBe(true);
  await page.getByRole("button", { name: "从本条消息移除 broken.png", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.attachmentUrls.created.every((url) => window.attachmentUrls.revoked.includes(url)))).toBe(true);
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.getByLabel("选择一个或多个材料").setInputFiles({ name: "leave.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>') });
  const leavingImage = page.getByRole("button", { name: "预览 leave.svg", exact: true });
  await expect(leavingImage.locator("img")).toBeVisible();
  const leavingUrl = await leavingImage.locator("img").getAttribute("src");
  // A client-side navigation unmounts the composer without replacing the monitored document.
  await page.evaluate(() => {
    history.pushState(null, "", "/login");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.locator(".workspaceComposer")).toHaveCount(0);
  await expect.poll(() => page.evaluate((url) => window.attachmentUrls.revoked.includes(url), leavingUrl)).toBe(true);
});
