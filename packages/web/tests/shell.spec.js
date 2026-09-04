const { test, expect } = require("@playwright/test");

async function expectViewportOverlay(page, backdropSelector, dialog) {
  const geometry = await page.locator(backdropSelector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      parentTag: element.parentElement?.tagName,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  expect(geometry.parentTag).toBe("BODY");
  expect(Math.abs(geometry.x)).toBeLessThan(1);
  expect(Math.abs(geometry.y)).toBeLessThan(1);
  expect(Math.abs(geometry.width - geometry.viewportWidth)).toBeLessThan(1);
  expect(Math.abs(geometry.height - geometry.viewportHeight)).toBeLessThan(1);

  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(geometry.viewportHeight);
}

async function installShellFixture(page, { workspaces = [{ id: "ws_1", name: "Default", status: "active", role: "owner" }] } = {}) {
  let authenticated = true;
  let agentCreateAttempts = 0;
  let libraryReads = 0;
  const deletedAgentIds = [];
  const passwordChangePayloads = [];
  const agents = [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", instructions: "保持判断清晰。", avatarKind: "centaeris", status: "active", deletedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z" }];
  let libraryObjects = [
    { id: "note_reference", displayName: "项目参考", objectKind: "note", contentType: "text/markdown", status: "ready" },
    { id: "note_welcome", displayName: "个人笔记", objectKind: "note", contentType: "text/markdown", status: "ready" },
  ];

  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "test-csrf" } });
    if (path === "/api/login" && method === "POST") {
      if (request.postDataJSON().password !== "correct-password") return route.fulfill({ status: 401, json: { error: "invalid_credentials" } });
      authenticated = true;
      return route.fulfill({ json: { user: { id: "user_1", email: "member@example.com", isStaff: false, isSuperuser: false } } });
    }
    if (path === "/api/logout" && method === "POST") {
      authenticated = false;
      return route.fulfill({ status: 204 });
    }
    if (!authenticated) {
      if (path === "/api/workspaces/ws_1/agents" && method === "POST") agentCreateAttempts += 1;
      return route.fulfill({ status: 401, json: { error: "authentication_required" } });
    }
    if (path === "/api/account/password" && method === "PATCH") {
      const payload = request.postDataJSON();
      passwordChangePayloads.push(payload);
      if (payload.currentPassword !== "correct-password") return route.fulfill({ status: 403, json: { error: "account_current_password_invalid" } });
      if (payload.newPassword === "short-password") return route.fulfill({ status: 400, json: { error: "account_password_invalid" } });
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/workspaces/ws_1/agents" && method === "GET") return route.fulfill({ json: { agents } });
    if (path === "/api/workspaces/ws_2/agents" && method === "GET") return route.fulfill({ json: { agents: [] } });
    if (path === "/api/workspaces/ws_1/agents" && method === "POST") {
      agentCreateAttempts += 1;
      const agent = { id: "agent_research", workspaceId: "ws_1", ...request.postDataJSON(), status: "active", deletedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z" };
      agents.push(agent);
      return route.fulfill({ status: 201, json: { agent } });
    }
    const agentMatch = path.match(/^\/api\/agents\/(.+)$/);
    if (agentMatch && method === "PATCH") {
      const agent = agents.find((item) => item.id === agentMatch[1]);
      Object.assign(agent, request.postDataJSON());
      return route.fulfill({ json: { agent } });
    }
    if (agentMatch && method === "DELETE") {
      deletedAgentIds.push(agentMatch[1]);
      agents.splice(agents.findIndex((item) => item.id === agentMatch[1]), 1);
      return route.fulfill({ json: { deleted: true } });
    }

    if (path === "/api/library/note_reference/note") return route.fulfill({ json: { object: { id: "note_reference", displayName: "项目参考", objectKind: "note" }, markdown: "# 项目参考\n\n这是搜索预览正文。" } });
    if (path === "/api/library/note_welcome/note") return route.fulfill({ json: { object: { id: "note_welcome", displayName: "个人笔记", objectKind: "note" }, markdown: "# 欢迎来到 Centaeris\n\n这是你的第一份私人文档。" } });
    if (path === "/api/library/note_welcome") return route.fulfill({ json: { object: { id: "note_welcome", displayName: "个人笔记", objectKind: "note", contentType: "text/markdown", status: "ready" } } });
    if (path === "/api/library") {
      libraryReads += 1;
      return route.fulfill({ json: { objects: libraryObjects } });
    }
    const responses = {
      "/api/me": { user: { id: "user_1", email: "member@example.com", isStaff: false, isSuperuser: false } },
      "/api/workspaces": { workspaces },
      "/api/models": { models: [{ id: "model_1", displayName: "Test", provider: "fake", modelName: "fake-model" }] },
      "/api/workspaces/ws_1/plugins": { plugins: [{ name: "banana", displayName: "banana", shortDescription: "合成扩展能力", version: "1.0.0", enabled: true, capabilities: ["Skills", "CLI"], skills: [{ path: "skills/banana/SKILL.md" }], cli: [{ path: "bin/banana" }], mcpServers: [], mcpCredentialRefs: [], hooks: [], errors: [] }] },
      "/api/workspaces/ws_1/skills": { schema: "workspace.skill.catalog.result.v1", skills: [{ skillId: "plugin-banana-0:banana", name: "banana", description: "合成扩展说明", enabled: true, allowImplicitInvocation: true, allowedTools: ["read", "bash"] }] },
      "/api/workspaces/ws_1/trash": { items: [], filterOptions: { deletedBy: [], locations: [] }, nextCursor: null, hasMore: false },
    };
    if (path === "/api/workspaces/ws_1/session-projects") return route.fulfill({ json: { projects: [] } });
    if (path === "/api/workspaces/ws_1/sessions") {
      const requestedAgentId = url.searchParams.get("agentId");
      if (requestedAgentId !== "centaeris") return route.fulfill({ json: { sessions: [] } });
      return route.fulfill({ json: { sessions: [{ id: "sess_1", workspaceId: "ws_1", agentId: "centaeris", title: "Lisp 与人工智能", origin: "user", status: "active" }] } });
    }
    return responses[path] ? route.fulfill({ json: responses[path] }) : route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  return {
    expireSession: () => { authenticated = false; },
    agentCreateAttempts: () => agentCreateAttempts,
    libraryReads: () => libraryReads,
    replaceLibraryObjects: (objects) => { libraryObjects = objects; },
    deletedAgentIds,
    passwordChangePayloads,
  };
}

test("renders the Notion-like home and split search preview", async ({ page }) => {
  await installShellFixture(page);
  await page.goto("/w/ws_1/agents/centaeris?new=1");

  await expect(page.locator(".shHomeAvatar")).toBeVisible();
  const composer = page.getByRole("textbox", { name: "输入消息" });
  await expect(composer).toBeFocused();
  await expect(composer.locator("..")).toHaveCSS("border-top-color", "rgb(35, 131, 226)");

  await page.getByRole("button", { name: "搜索会话和笔记" }).click();
  const dialog = page.getByRole("dialog", { name: "聚合搜索" });
  await expect(dialog.getByRole("textbox", { name: "搜索会话和笔记" })).toBeFocused();
  await expect(dialog.getByRole("option", { name: /项目参考/ })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("complementary", { name: "搜索结果预览" })).toContainText("这是搜索预览正文。");
  await dialog.getByRole("option", { name: /Lisp 与人工智能/ }).hover();
  await expect(dialog.getByRole("complementary", { name: "搜索结果预览" }).getByRole("heading", { name: "Lisp 与人工智能" })).toBeVisible();
  const searchInput = dialog.getByRole("textbox", { name: "搜索会话和笔记" });
  await searchInput.hover();
  await searchInput.fill("Lisp");
  await expect(dialog.getByRole("option", { name: /Lisp 与人工智能/ })).toHaveAttribute("aria-selected", "true");
  await searchInput.fill("");
  await expect(dialog.getByRole("option", { name: /项目参考/ })).toHaveAttribute("aria-selected", "true");
});

test("refreshes private notes after client-side navigation", async ({ page }) => {
  const fixture = await installShellFixture(page);
  await page.goto("/w/ws_1/app");
  await expect(page.getByRole("link", { name: "个人笔记", exact: true })).toBeVisible();
  const readsBeforeNavigation = fixture.libraryReads();
  fixture.replaceLibraryObjects([
    { id: "note_refreshed", displayName: "导航后新增", objectKind: "note", contentType: "text/markdown", status: "ready" },
  ]);
  const sidebar = page.getByRole("complementary", { name: "会话导航", exact: true });

  await sidebar.getByRole("link", { name: "库", exact: true }).click();

  await expect.poll(fixture.libraryReads).toBeGreaterThan(readsBeforeNavigation);
  await expect(sidebar.getByRole("link", { name: "导航后新增", exact: true })).toBeVisible();
});

test("uses the default Agent draft at the workspace URL and exposes creation surfaces", async ({ page }) => {
  await installShellFixture(page);
  await page.goto("/w/ws_1/app");

  await expect(page).toHaveURL(/\/w\/ws_1\/app$/);
  await expect(page.getByRole("navigation", { name: "当前会话" })).toHaveCount(0);
  await expect(page.getByPlaceholder("描述你希望 Centaeris 协助完成的任务…")).toBeVisible();
  await expect(page.getByRole("tab", { name: "主页", exact: true })).toHaveAttribute("aria-selected", "true");
  const privateDisclosure = page.locator(".shDisclosure");
  const privateNote = page.getByRole("link", { name: "个人笔记", exact: true });
  await expect(privateDisclosure).toHaveAttribute("open", "");
  const privateSummary = page.locator(".shDisclosureSummary");
  await expect(privateSummary).toHaveCSS("height", "30px");
  await privateSummary.hover();
  await expect(privateSummary).toHaveCSS("background-color", "rgba(0, 0, 0, 0.067)");
  await expect(page.getByRole("link", { name: "添加代理", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "添加代理", exact: true }).locator("svg.lucide-bot")).toBeVisible();
  await expect(page.locator(".shPrimaryNav")).toHaveCSS("margin-top", "24px");
  await expect(page.getByText("我的任务", { exact: true })).toHaveCount(0);
  await privateSummary.click();
  await expect(privateDisclosure).not.toHaveAttribute("open", "");
  await expect(privateNote).not.toBeVisible();
  await privateSummary.click();
  await expect(privateNote).toBeVisible();
  await page.getByRole("button", { name: "垃圾桶" }).click();
  await expect(page.getByRole("dialog", { name: "垃圾桶" })).toBeVisible();
  await page.getByRole("button", { name: "垃圾桶" }).click();
  await expect(page.getByRole("dialog", { name: "垃圾桶" })).toHaveCount(0);
  await privateNote.click();
  await expect(page).toHaveURL(/\/w\/ws_1\/library\/note_welcome$/);
  await page.getByRole("button", { name: "重命名笔记" }).click();
  await expect(page.getByRole("textbox", { name: "笔记标题" })).toHaveValue("欢迎来到 Centaeris");
  await expect(page.getByRole("textbox", { name: "笔记正文" })).toHaveValue("这是你的第一份私人文档。");
  await page.goto("/w/ws_1/app");

  await page.getByRole("button", { name: "打开新增菜单" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveCount(2);
  await expect(menu).toContainText("笔记对话");
  await expect(menu).not.toContainText("上传资料");
  await expect(menu).not.toContainText("Agent");
  await page.locator(".workspaceChatColumn").click({ position: { x: 40, y: 40 } });
  await expect(menu).toHaveCount(0);

  await page.getByRole("button", { name: "新增", exact: true }).click();
  const privateCreate = page.getByRole("dialog", { name: "新增私人内容" });
  await expect(privateCreate).toBeVisible();
  await expectViewportOverlay(page, ".shPrivateCreateBackdrop", privateCreate);
  await expect(privateCreate.getByRole("button", { name: "空白笔记" })).toBeVisible();
  await expect(privateCreate.getByRole("button", { name: "上传资料" })).toBeVisible();
  await expect(privateCreate.getByRole("heading", { name: "模板" })).toBeVisible();
  await expect(privateCreate.locator(".shPrivateTemplateCard")).toHaveCount(8);
  await privateCreate.getByRole("button", { name: /研究笔记/ }).click();
  await expect(page).toHaveURL(/\/w\/ws_1\/library\/new$/);
  await expect(page.getByRole("textbox", { name: "笔记标题" })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "笔记标题" })).toHaveValue("研究笔记");
  await expect(page.getByRole("button", { name: "Default 工作区菜单" })).toBeVisible();
});

test("opens the real library without a second management page", async ({ page }) => {
  await installShellFixture(page);
  await page.goto("/w/ws_1/library");

  await expect(page.getByRole("heading", { name: "库", exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "个人资料库文件", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "管理资料", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "在私人中新增" }).click();
  await expect(page.getByRole("dialog", { name: "新增私人内容" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/w\/ws_1\/library\/new$/);
  await expect(page.getByRole("textbox", { name: "笔记标题" })).toHaveValue("");
  await page.goto("/w/ws_1/library");

  await expect(page.getByRole("tab", { name: "代理", exact: true }).locator("svg.lucide-bot")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Skills", exact: true }).locator("svg.lucide-layers")).toBeVisible();
  await page.getByRole("textbox", { name: "搜索当前库", exact: true }).fill("不会匹配代理");
  await page.getByRole("tab", { name: "代理", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "搜索当前库", exact: true })).toHaveValue("");
  await expect(page.getByRole("link", { name: /Centaeris/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: "插件", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "插件", exact: true })).toHaveCount(0);

  const privateCreateTrigger = page.getByRole("button", { name: "新增", exact: true });
  await privateCreateTrigger.click();
  const privateCreate = page.getByRole("dialog", { name: "新增私人内容" });
  await expect(privateCreate).toBeVisible();
  await expectViewportOverlay(page, ".shPrivateCreateBackdrop", privateCreate);
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  const privateClose = privateCreate.getByRole("button", { name: "关闭新增" });
  const lastTemplate = privateCreate.locator(".shPrivateTemplateCard").last();
  await privateClose.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(lastTemplate).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(privateClose).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(privateCreate).toHaveCount(0);
  await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  await expect(privateCreateTrigger).toBeFocused();

  const searchTrigger = page.getByRole("button", { name: "搜索会话和笔记" });
  await searchTrigger.click();
  const searchDialog = page.getByRole("dialog", { name: "聚合搜索" });
  await expect(searchDialog).toBeVisible();
  await expectViewportOverlay(page, ".shSearchBackdrop", searchDialog);
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(searchDialog).toHaveCount(0);
  await expect(searchTrigger).toBeFocused();

  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  await expect(page.getByRole("table", { name: "Skills", exact: true })).toContainText("合成扩展说明");

  const trashTrigger = page.getByRole("button", { name: "垃圾桶" });
  await trashTrigger.click();
  const trashDialog = page.getByRole("dialog", { name: "垃圾桶" });
  await expect(trashDialog).toBeVisible();
  const triggerBox = await trashTrigger.boundingBox();
  const dialogBox = await trashDialog.boundingBox();
  expect(Math.abs(dialogBox.x - triggerBox.x - triggerBox.width - 8)).toBeLessThan(1);
  expect(Math.abs(dialogBox.y - triggerBox.y)).toBeLessThan(1);
  await page.getByRole("button", { name: "隐藏左侧栏" }).click();
  await expect(trashDialog).toHaveCount(0);
});

test("shows workspace identity and logs out from the workspace menu", async ({ page }) => {
  const session = await installShellFixture(page);
  await page.goto("/w/ws_1/app");

  await page.getByRole("button", { name: "Default 工作区菜单" }).click();
  await expect(page.getByText("所有者", { exact: true })).toBeVisible();
  await expect(page.getByText("member@example.com", { exact: true })).toBeVisible();
  const popoverOwnsRightEdge = await page.evaluate(() => {
    const sidebar = document.querySelector(".workspaceSidebarSlot").getBoundingClientRect();
    const popover = document.querySelector(".shWsMenuPopover").getBoundingClientRect();
    return Boolean(document.elementFromPoint(sidebar.right + 4, popover.top + 16)?.closest(".shWsMenuPopover"));
  });
  expect(popoverOwnsRightEdge).toBe(true);
  session.expireSession();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("dialog", { name: "重新登录" })).toHaveCount(0);
});

test("skips the chooser for one workspace and remembers a validated workspace switch", async ({ page }) => {
  const workspaces = [
    { id: "ws_1", name: "Default", status: "active", role: "owner" },
    { id: "ws_2", name: "Research", status: "active", role: "member" },
  ];
  await installShellFixture(page, { workspaces });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "选择工作区" })).toBeVisible();
  await expect(page.locator(".shWorkspaceChooser > section > p")).toHaveCount(0);
  const chooserRow = page.getByRole("link", { name: "Default 所有者" });
  expect((await chooserRow.boundingBox()).height).toBeLessThanOrEqual(36);
  await chooserRow.click();

  await page.getByRole("button", { name: "Default 工作区菜单" }).click();
  const switcher = page.getByLabel("切换工作区");
  await expect(switcher.locator("[aria-current=page]")).toContainText("Default");
  const researchRow = switcher.getByRole("link", { name: "Research" });
  expect((await researchRow.boundingBox()).height).toBeLessThanOrEqual(32);
  await expect(page.getByRole("link", { name: "切换工作区" })).toHaveCount(0);
  await researchRow.click();
  await expect(page).toHaveURL(/\/w\/ws_2\/app$/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("centaeris:last-workspace:user_1"))).toBe("ws_2");

  await page.goto("/");
  await expect(page).toHaveURL(/\/w\/ws_2\/app$/);
});

test("redirects the explicit chooser route when only one workspace is available", async ({ page }) => {
  await installShellFixture(page);
  await page.goto("/workspaces");
  await expect(page).toHaveURL(/\/w\/ws_1\/app$/);
  await expect(page.getByRole("heading", { name: "选择工作区" })).toHaveCount(0);
});

test("workspace chooser retains its actual empty state", async ({ page }) => {
  await installShellFixture(page, { workspaces: [] });
  await page.goto("/workspaces");
  await expect(page.getByRole("heading", { name: "选择工作区" })).toBeVisible();
  await expect(page.getByText("当前账号还没有可访问的工作区。", { exact: true })).toBeVisible();
});

for (const path of ["/w/ws_1/app/", "/w/ws_1/settings/preferences", "/settings/preferences", "/settings/preferences?workspaceId=ws_1"]) {
test(`loads ${path} directly without creating an unrelated conversation`, async ({ page }) => {
  await installShellFixture(page);
  let chatRequests = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/models" || pathname.includes("/sessions") || pathname.includes("/session-projects")) chatRequests += 1;
  });
  await page.goto(path);
  if (path.endsWith("/app/")) {
    await expect(page.getByRole("textbox", { name: "输入消息", exact: true })).toBeVisible();
  } else {
    await expect(page.getByRole("dialog", { name: "偏好", exact: true })).toBeVisible();
    await expect(page.locator("#messageDraft")).toHaveCount(0);
    expect(chatRequests).toBe(0);
  }
});
}

test("persists input preferences and keeps security in the administrator section", async ({ page }) => {
  const fixture = await installShellFixture(page);
  await page.goto("/w/ws_1/app");
  await page.getByRole("button", { name: "Default 工作区菜单" }).click();
  await expect(page.getByRole("link", { name: "工作区设置" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "设置", exact: true })).toHaveCount(1);
  await page.getByRole("link", { name: "设置", exact: true }).click();

  await expect(page).toHaveURL(/\/w\/ws_1\/settings\/preferences$/);
  let dialog = page.getByRole("dialog", { name: "偏好" });
  await expect(dialog.getByRole("heading", { name: "工作空间" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "管理员" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "账户", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "功能" })).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "超级管理员" })).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: "用户组", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: "插件", exact: true }).locator("svg")).toHaveClass(/lucide-plug/);
  await expect(dialog.getByText("member@example.com", { exact: true })).toHaveCount(0);
  const settingsDialogBox = await dialog.boundingBox();
  const settingsCloseBox = await dialog.getByRole("button", { name: "关闭", exact: true }).boundingBox();
  const contentHeadingBox = await dialog.getByRole("heading", { name: "输入选项", exact: true }).boundingBox();
  expect(settingsCloseBox.x).toBeLessThan(contentHeadingBox.x);
  expect(settingsCloseBox.x - settingsDialogBox.x).toBeLessThanOrEqual(12);
  expect(settingsCloseBox.y - settingsDialogBox.y).toBeLessThanOrEqual(12);
  const preference = dialog.getByRole("switch", { name: "使用 Enter 键开始新的一行" });
  await expect(preference).not.toBeChecked();
  await preference.check();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("centaeris:composer-enter-new-line:v1:user_1"))).toBe("1");

  await dialog.getByRole("link", { name: "安全", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/ws_1\/settings\/security$/);
  dialog = page.getByRole("dialog", { name: "安全" });
  await expect(page.locator(".accountSecuritySettings > header p")).toHaveCount(0);
  await expect(dialog.getByText("至少 15 个字符。", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel(/^新密码/)).toHaveAttribute("minlength", "15");
  await dialog.getByLabel("当前密码").fill("wrong-password");
  await dialog.getByLabel(/^新密码/).fill("Replacement-Passphrase!2027");
  await dialog.getByLabel("确认新密码").fill("Replacement-Passphrase!2027");
  await dialog.getByRole("button", { name: "更新密码" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("当前密码不正确。");

  await dialog.getByLabel("当前密码").fill("correct-password");
  await dialog.getByRole("button", { name: "更新密码" }).click();
  await expect(dialog.getByRole("status")).toContainText("当前设备保持登录");
  expect(fixture.passwordChangePayloads.at(-1)).toEqual({
    currentPassword: "correct-password",
    newPassword: "Replacement-Passphrase!2027",
  });
  await expect(dialog.getByLabel("当前密码")).toHaveValue("");
});

test("keeps account security available to members without exposing workspace management", async ({ page }) => {
  await installShellFixture(page, { workspaces: [{ id: "ws_1", name: "Default", status: "active", role: "member" }] });
  await page.goto("/w/ws_1/app");
  await page.getByRole("button", { name: "Default 工作区菜单" }).click();
  await expect(page.getByRole("link", { name: "工作区设置" })).toHaveCount(0);
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("dialog", { name: "偏好" }).getByRole("link", { name: "安全", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "安全" });
  await expect(dialog.getByRole("heading", { name: "工作空间" })).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: "通用" })).toHaveCount(0);

  await page.goto("/w/ws_1/settings/general");
  await expect(page).toHaveURL(/\/w\/ws_1\/app$/);
});

test("creates and edits a private Agent through Django APIs", async ({ page }) => {
  const fixture = await installShellFixture(page);
  await page.goto("/w/ws_1/agents/new");
  const agentForm = page.getByRole("dialog", { name: "创建私人代理" });
  await expect(agentForm).toHaveAttribute("aria-modal", "true");
  await expect(page.locator(".shSidebar")).toHaveAttribute("inert", "");
  const closeButton = agentForm.getByRole("button", { name: "关闭" });
  const closeBox = await closeButton.boundingBox();
  const headingBox = await agentForm.getByRole("heading", { name: "创建私人代理" }).boundingBox();
  expect(closeBox.x).toBeLessThan(headingBox.x);
  await closeButton.hover();
  await expect(closeButton).toHaveCSS("background-color", "rgb(233, 233, 230)");
  await expect(closeButton).toHaveCSS("color", "rgb(55, 53, 47)");
  await expect(page.getByRole("button", { name: "Centaeris" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "none" }).click();
  await expect(page.getByRole("button", { name: "none" })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("代理名称").fill("研究助手");
  await page.getByLabel("代理简介").fill("负责资料研究");
  await closeButton.click();
  const discardPrompt = agentForm.getByRole("alert");
  await expect(discardPrompt).toContainText("放弃未保存的更改？");
  await expect(page.locator(".themeConfirmBackdrop")).toHaveCount(0);
  await expect(discardPrompt.getByRole("button", { name: "继续编辑" })).toBeFocused();
  await discardPrompt.getByRole("button", { name: "继续编辑" }).click();
  await expect(page.getByLabel("代理名称")).toHaveValue("研究助手");
  await page.getByRole("button", { name: "编辑 SOUL.md" }).click();
  await expect(page.getByRole("region", { name: "创建私人代理 SOUL.md" })).toBeVisible();
  await expect(page.locator(".shModalBackdrop")).toHaveCount(0);
  await page.getByLabel("代理指令").focus();
  await expect(page.getByLabel("代理指令")).toHaveCSS("outline-style", "none");
  await expect.poll(() => page.locator(".shSoulDocumentPage .libraryNoteEditor").evaluate((element) => getComputedStyle(element, "::before").backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  await expect(page.locator(".shSoulDocumentPage .libraryPreviewBody.libraryNotePreview .libraryNoteEditor")).toBeVisible();
  await expect(page.locator(".shSoulDocumentTopbar, .shSoulDocumentPaper")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "SOUL.md 地址" })).toContainText("代理/SOUL.md私人");
  await expect(page.getByRole("heading", { name: "SOUL.md" })).toHaveCount(0);
  await expect(page.getByLabel("代理指令")).toHaveAttribute("placeholder", "# 身份与职责\n\n写下这个代理应遵循的工作方式与行为边界…");
  await page.getByLabel("代理指令").fill("先核验一手资料，再给出有出处的结论。");
  await page.getByLabel("代理指令").press("Escape");
  await expect(page.getByRole("dialog", { name: "创建私人代理" })).toBeVisible();
  await page.getByRole("button", { name: "编辑 SOUL.md" }).click();
  await expect(page.getByLabel("代理指令")).toHaveValue("先核验一手资料，再给出有出处的结论。");
  await page.getByRole("button", { name: "完成编辑" }).click();
  await page.getByRole("button", { name: "创建代理" }).click();

  await expect(page).toHaveURL(/\/w\/ws_1\/agents\/agent_research\?new=1$/);
  await page.goto("/w/ws_1/agents/agent_research/settings");
  await expect(page.getByRole("heading", { name: "研究助手" })).toBeVisible();
  await expect(page.getByText("负责资料研究", { exact: true })).toBeVisible();
  await expect(page.getByText("先核验一手资料，再给出有出处的结论。", { exact: true })).toBeVisible();
  await expect(page.locator(".shAgentPageIcon img")).toHaveAttribute("src", "/agent-avatar-banana.png");
  await expect(page.getByText("MEMORY.md", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "编辑代理" }).click();
  await page.getByRole("button", { name: "Centaeris" }).click();
  await page.getByLabel("代理简介").fill("负责深入研究与整理");
  await page.getByRole("button", { name: "编辑 SOUL.md" }).click();
  await page.getByLabel("代理指令").fill("结论必须区分事实与推断。");
  await page.getByRole("button", { name: "完成编辑" }).click();
  await page.getByRole("button", { name: "保存更改" }).click();
  await expect(page.getByText("负责深入研究与整理", { exact: true })).toBeVisible();
  await expect(page.getByText("结论必须区分事实与推断。", { exact: true })).toBeVisible();
  await expect(page.locator(".shAgentPageIcon img")).toHaveAttribute("src", "/centaeris-mark.png");
  await expect(page.getByText("行为边界", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "移到垃圾桶", exact: true }).click();
  await expect(page.locator(".themeConfirmDialog")).toHaveCount(0);
  await expect.poll(() => fixture.deletedAgentIds).toEqual(["agent_research"]);
  await expect(page).toHaveURL(/\/w\/ws_1\/app$/);
});

test("reauthenticates in place without losing an Agent draft or retrying its mutation", async ({ page }) => {
  const session = await installShellFixture(page);
  await page.goto("/w/ws_1/agents/new");
  await page.getByLabel("代理名称").fill("仍在页面的草稿");
  await page.getByLabel("代理简介").fill("Session 失效后不能丢失");
  session.expireSession();

  await page.getByRole("button", { name: "创建代理" }).click();
  const reauthentication = page.getByRole("dialog", { name: "重新登录" });
  await expect(reauthentication).toBeVisible();
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  await expect(reauthentication.getByLabel("邮箱")).toHaveValue("member@example.com");
  await expect(reauthentication.getByLabel("邮箱")).toHaveAttribute("readonly", "");
  await expect(page.getByLabel("代理名称")).toHaveValue("仍在页面的草稿");
  expect(session.agentCreateAttempts()).toBe(1);

  await reauthentication.getByLabel("密码").fill("wrong-password");
  await reauthentication.getByRole("button", { name: "重新登录" }).click();
  await expect(reauthentication.getByRole("alert")).toHaveText("密码不正确，请重试。");
  await expect(page.getByLabel("代理名称")).toHaveValue("仍在页面的草稿");
  await reauthentication.getByLabel("密码").fill("correct-password");
  await reauthentication.getByRole("button", { name: "重新登录" }).click();
  const restored = page.getByRole("dialog", { name: "登录已恢复" });
  await expect(restored).toContainText("刚才失败的操作没有自动重试");
  await expect(page.getByLabel("代理名称")).toHaveValue("仍在页面的草稿");
  expect(session.agentCreateAttempts()).toBe(1);

  await restored.getByRole("button", { name: "返回继续" }).click();
  await expect(restored).toHaveCount(0);
  await expect(page.getByLabel("代理简介")).toHaveValue("Session 失效后不能丢失");
  await page.getByRole("button", { name: "创建代理" }).click();
  await expect(page).toHaveURL(/\/w\/ws_1\/agents\/agent_research\?new=1$/);
  expect(session.agentCreateAttempts()).toBe(2);
});

test("keeps a chat draft and pending file through in-place reauthentication", async ({ page }) => {
  const session = await installShellFixture(page);
  await page.goto("/w/ws_1/agents/centaeris?new=1");
  await page.getByLabel("输入消息").fill("这段对话草稿必须保留");
  await page.getByLabel("选择一个或多个材料").setInputFiles({
    name: "session-draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("draft"),
  });
  session.expireSession();

  await page.getByRole("button", { name: "输入", exact: true }).click();
  const reauthentication = page.getByRole("dialog", { name: "重新登录" });
  await expect(reauthentication).toBeVisible();
  await expect(page.getByLabel("输入消息")).toHaveValue("这段对话草稿必须保留");
  await expect(page.getByLabel("本次对话参考材料").getByText("session-draft.txt", { exact: true })).toBeAttached();

  await reauthentication.getByLabel("密码").fill("correct-password");
  await reauthentication.getByRole("button", { name: "重新登录" }).click();
  await page.getByRole("dialog", { name: "登录已恢复" }).getByRole("button", { name: "返回继续" }).click();
  await expect(page.getByLabel("输入消息")).toHaveValue("这段对话草稿必须保留");
  await expect(page.getByLabel("本次对话参考材料").getByText("session-draft.txt", { exact: true })).toBeVisible();
});
