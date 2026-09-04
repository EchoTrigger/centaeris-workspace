const { test, expect } = require("@playwright/test");

test("does not persist an untouched note draft", async ({ page }) => {
  let notePosts = 0;
  let note = null;
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "test-token" } });
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "user_1", email: "member@example.com" } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "Default", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [{ id: "centaeris", name: "Centaeris", description: "", workspaceId: "ws_1", avatarKind: "centaeris", status: "active" }] } });
    if (path === "/api/library/notes" && request.method() === "POST") {
      notePosts += 1;
      const body = request.postDataJSON();
      expect(body).toEqual({ displayName: "需求", markdown: "# 需求", parentFolderId: "" });
      note = { id: "note_1", objectKind: "note", contentType: "text/markdown", displayName: body.displayName, status: "ready" };
      return route.fulfill({ status: 201, json: { object: note } });
    }
    if (path === "/api/library/note_1") return route.fulfill({ json: { object: note } });
    if (path === "/api/library/note_1/note") return route.fulfill({ json: { object: note, markdown: "# 需求" } });
    if (path === "/api/library") return route.fulfill({ json: { objects: note ? [note] : [] } });
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/library/new");
  expect(notePosts).toBe(0);
  await expect(page.getByRole("textbox", { name: "笔记标题", exact: true })).toBeEmpty();
  await expect(page.getByRole("textbox", { name: "笔记正文", exact: true })).toBeEmpty();
  await expect(page.getByRole("textbox", { name: "笔记标题", exact: true })).toHaveCSS("box-shadow", "none");
  await page.getByRole("textbox", { name: "笔记正文", exact: true }).focus();
  expect(await page.locator(".libraryNoteEditor").evaluate((element) => getComputedStyle(element, "::before").backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  await page.goto("/w/ws_1/library");
  await expect(page).toHaveURL(/\/w\/ws_1\/library$/);
  expect(notePosts).toBe(0);

  await page.goto("/w/ws_1/library/new");
  const created = page.waitForResponse((response) => response.url().endsWith("/api/library/notes") && response.request().method() === "POST");
  await page.getByRole("textbox", { name: "笔记标题", exact: true }).fill("需求");
  await created;
  await expect(page).toHaveURL(/\/w\/ws_1\/library\/note_1$/);
  expect(notePosts).toBe(1);
});

test("keeps the flat note identity visible when the sidebar is closed", async ({ page }) => {
  const reads = { object: 0, note: 0 };
  await page.route("http://localhost:8000/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses = {
      "/api/me": { user: { id: "user_1", email: "member@example.com" } },
      "/api/workspaces": { workspaces: [{ id: "ws_1", name: "Default", role: "owner" }] },
      "/api/workspaces/ws_1/agents": { agents: [{ id: "centaeris", name: "Centaeris", description: "", workspaceId: "ws_1", avatarKind: "centaeris", status: "active" }] },
      "/api/library/note_1": { object: { id: "note_1", objectKind: "note", contentType: "text/markdown", displayName: "需求.md", status: "ready" } },
      "/api/library/note_1/note": { object: { id: "note_1", objectKind: "note", contentType: "text/markdown", displayName: "需求.md", status: "ready" }, markdown: "# 需求" },
    };
    if (path === "/api/library/note_1") reads.object += 1;
    if (path === "/api/library/note_1/note") reads.note += 1;
    return responses[path] ? route.fulfill({ json: responses[path] }) : route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/library/note_1");
  const previewWidth = (await page.locator(".libraryPreviewMain").boundingBox())?.width;
  await page.getByRole("button", { name: "隐藏左侧栏", exact: true }).click();
  const showSidebar = page.getByRole("button", { name: "显示左侧栏", exact: true });
  await expect(showSidebar).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(showSidebar).toHaveCSS("box-shadow", "none");
  const address = page.getByLabel("笔记地址", { exact: true });
  await expect(address).toContainText("需求");
  await expect(address).toContainText("私人");
  await expect(address).toContainText("/");
  await address.getByRole("button", { name: "重命名笔记" }).click();
  await expect(address.getByRole("textbox", { name: "笔记标题" })).toHaveValue("需求");
  await expect(page.locator(".libraryPreviewHeader")).toHaveCSS("border-bottom-width", "0px");
  expect((await address.boundingBox())?.x).toBeGreaterThanOrEqual(52);
  await page.waitForTimeout(400);
  expect(reads).toEqual({ object: 1, note: 1 });
  expect((await page.locator(".libraryPreviewMain").boundingBox())?.width).toBeGreaterThan(previewWidth);
});

test("loads each library folder once and ignores selection-only rerenders", async ({ page }) => {
  const reads = { root: 0, child: 0, folder: 0 };
  const folder = { id: "folder_1", objectKind: "folder", contentType: "application/x-directory", displayName: "项目资料", status: "ready", parentFolderId: null, updatedAt: "2026-07-15T00:00:00Z" };
  const file = { id: "file_1", objectKind: "file", contentType: "text/plain", displayName: "计划.txt", status: "ready", parentFolderId: folder.id, updatedAt: "2026-07-15T00:00:00Z", sizeBytes: 12 };
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "test-token" } });
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "user_1", email: "member@example.com" } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "默认工作区", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [{ id: "centaeris", name: "Centaeris", description: "", workspaceId: "ws_1", avatarKind: "centaeris", status: "active" }] } });
    if (path === "/api/library/folder_1") {
      reads.folder += 1;
      return route.fulfill({ json: { object: folder } });
    }
    if (path === "/api/library" && url.searchParams.get("parentFolderId") === folder.id) {
      reads.child += 1;
      return route.fulfill({ json: { objects: [file] } });
    }
    if (path === "/api/library") {
      reads.root += 1;
      return route.fulfill({ json: { objects: [folder] } });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/library");
  const rootFolder = page.getByRole("cell", { name: "项目资料", exact: true });
  await expect(rootFolder).toBeVisible();
  const initialReads = { ...reads };
  await rootFolder.click();
  await expect(page).toHaveURL(/folder=folder_1/);
  await expect(page.getByRole("cell", { name: "计划.txt", exact: true })).toBeVisible();
  expect(reads).toEqual({ root: initialReads.root, child: 1, folder: 1 });

  await page.getByRole("checkbox", { name: "选择 计划.txt", exact: true }).check();
  await page.getByRole("checkbox", { name: "取消全选", exact: true }).click();
  await page.waitForTimeout(100);
  expect(reads).toEqual({ root: initialReads.root, child: 1, folder: 1 });

  await page.getByRole("navigation", { name: "当前文件夹", exact: true }).getByRole("button", { name: "资料库", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/ws_1\/library$/);
  await expect(page.getByRole("cell", { name: "项目资料", exact: true })).toBeVisible();
  expect(reads).toEqual({ root: initialReads.root + 1, child: 1, folder: 1 });
});

test("library supports multi-select and select-all", async ({ page }) => {
  const deleteRequests = [];
  let objects = [
    { id: "file_1", objectKind: "file", contentType: "text/plain", displayName: "需求.md", status: "ready", updatedAt: "2026-07-15T00:00:00Z", sizeBytes: 12 },
    { id: "file_2", objectKind: "file", contentType: "text/plain", displayName: "计划.md", status: "ready", updatedAt: "2026-07-14T00:00:00Z", sizeBytes: 24 },
  ];
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "test-token" } });
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "user_1", email: "member@example.com" } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "默认工作区", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [{ id: "centaeris", name: "Centaeris", description: "", workspaceId: "ws_1", avatarKind: "centaeris", status: "active" }] } });
    if (path === "/api/library/file_1" && request.method() === "DELETE") {
      deleteRequests.push(path);
      objects = objects.filter((item) => item.id !== "file_1");
      return route.fulfill({ json: { deleted: true } });
    }
    if (path === "/api/library") return route.fulfill({ json: { objects } });
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/library");
  await page.getByRole("checkbox", { name: "选择 需求.md", exact: true }).check();
  await expect(page.locator(".libraryList")).toHaveClass(/hasSelection/);
  await expect(page.getByRole("checkbox", { name: "全选当前列表", exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "选择 计划.md", exact: true }).check();
  await expect(page.getByText("已选 2 个", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始聊天", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "下载", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "移动", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "移到垃圾桶", exact: true })).toBeEnabled();
  await page.getByRole("checkbox", { name: "取消全选", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "选择 需求.md", exact: true })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "选择 计划.md", exact: true })).not.toBeChecked();
  await page.getByRole("checkbox", { name: "选择 需求.md", exact: true }).check();
  await page.getByRole("button", { name: "移到垃圾桶", exact: true }).click();
  await expect(page.locator(".themeConfirmDialog")).toHaveCount(0);
  await expect.poll(() => deleteRequests).toEqual(["/api/library/file_1"]);
  await expect(page.getByRole("checkbox", { name: "选择 需求.md", exact: true })).toHaveCount(0);
});

test("library uploads one atomic batch with repeated files fields", async ({ page }) => {
  let uploadBody = "";
  let uploaded = false;
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "test-token" } });
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "user_1", email: "member@example.com" } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "默认工作区", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [{ id: "centaeris", name: "Centaeris", description: "", workspaceId: "ws_1", avatarKind: "centaeris", status: "active" }] } });
    if (path === "/api/library" && request.method() === "POST") {
      uploadBody = request.postDataBuffer().toString("utf8");
      uploaded = true;
      return route.fulfill({ status: 201, json: { objects: [
        { id: "file_1", objectKind: "file", contentType: "text/plain", displayName: "第一份.txt", status: "ready", updatedAt: "2026-07-20T00:00:00Z", sizeBytes: 5 },
        { id: "file_2", objectKind: "file", contentType: "text/markdown", displayName: "第二份.md", status: "ready", updatedAt: "2026-07-20T00:00:00Z", sizeBytes: 6 },
      ] } });
    }
    if (path === "/api/library") return route.fulfill({ json: { objects: uploaded ? [
      { id: "file_1", objectKind: "file", contentType: "text/plain", displayName: "第一份.txt", status: "ready", updatedAt: "2026-07-20T00:00:00Z", sizeBytes: 5 },
      { id: "file_2", objectKind: "file", contentType: "text/markdown", displayName: "第二份.md", status: "ready", updatedAt: "2026-07-20T00:00:00Z", sizeBytes: 6 },
    ] : [] } });
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/library");
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByRole("menuitem", { name: "上传文件", exact: true }).click();
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["first"], "第一份.txt", { type: "text/plain", lastModified: 1 }));
    transfer.items.add(new File(["second"], "第二份.md", { type: "text/markdown", lastModified: 2 }));
    return transfer;
  });
  await expect(page.getByRole("button", { name: "上传 0 个文件", exact: true })).toBeDisabled();
  await expect(page.locator(".libraryUploadQueueEmpty")).toHaveCount(0);
  await expect(page.getByText("添加到我的资料", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /拖入一个或多个文件/ }).dispatchEvent("drop", { dataTransfer });

  await expect(page.getByText("第一份.txt", { exact: true })).toBeVisible();
  await expect(page.getByText("第二份.md", { exact: true })).toBeVisible();
  expect(uploadBody).toBe("");
  await page.getByRole("button", { name: "上传 2 个文件", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "上传文件", exact: true })).toHaveCount(0);
  expect(uploadBody.match(/name="files"/g)).toHaveLength(2);
  expect(uploadBody).toContain('filename="第一份.txt"');
  expect(uploadBody).toContain('filename="第二份.md"');
});

test("library rejects more than fifty files before sending a request", async ({ page }) => {
  let uploadRequests = 0;
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "user_1", email: "member@example.com" } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "默认工作区", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [{ id: "centaeris", name: "Centaeris", description: "", workspaceId: "ws_1", avatarKind: "centaeris", status: "active" }] } });
    if (path === "/api/library" && request.method() === "POST") uploadRequests += 1;
    if (path === "/api/library") return route.fulfill({ json: { objects: [] } });
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/library");
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByRole("menuitem", { name: "上传文件", exact: true }).click();
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    for (let index = 0; index < 51; index += 1) {
      transfer.items.add(new File(["x"], `文件-${index}.txt`, { type: "text/plain", lastModified: index + 1 }));
    }
    return transfer;
  });
  await page.getByRole("button", { name: /拖入一个或多个文件/ }).dispatchEvent("drop", { dataTransfer });

  await expect(page.getByRole("alert")).toContainText("一次最多上传 50 个文件");
  expect(uploadRequests).toBe(0);
});

test("library file picker queues one file at a time and cancel discards the queue", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let uploadRequests = 0;
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "user_1", email: "member@example.com" } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "默认工作区", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [{ id: "centaeris", name: "Centaeris", description: "", workspaceId: "ws_1", avatarKind: "centaeris", status: "active" }] } });
    if (path === "/api/library" && request.method() === "POST") uploadRequests += 1;
    if (path === "/api/library") return route.fulfill({ json: { objects: [] } });
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/library");
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByRole("menuitem", { name: "上传文件", exact: true }).click();
  const picker = page.getByLabel("选择一个文件");
  await picker.setInputFiles({ name: "第一份.txt", mimeType: "text/plain", buffer: Buffer.from("first") });
  await picker.setInputFiles({ name: "第二份.md", mimeType: "text/markdown", buffer: Buffer.from("second") });

  await expect(page.getByRole("button", { name: "上传 2 个文件", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "上传文件", exact: true })).toHaveCount(0);
  expect(uploadRequests).toBe(0);
});
