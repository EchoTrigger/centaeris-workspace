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
      "/api/models": { models: [{ id: "model_1", displayName: "测试", provider: "fake", modelName: "fake-model" }] },
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
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeFocused();
  await expect(composer.locator("..")).toHaveCSS("border-top-color", "rgb(36, 105, 199)");

  await page.getByRole("button", { name: "Search conversations and notes" }).click();
  const dialog = page.getByRole("dialog", { name: "Workspace search" });
  await expect(dialog.getByRole("textbox", { name: "Search conversations and notes" })).toBeFocused();
  await expect(dialog.getByRole("option", { name: /项目参考/ })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("complementary", { name: "Search result preview" })).toContainText("这是搜索预览正文。");
  await dialog.getByRole("option", { name: /Lisp 与人工智能/ }).hover();
  await expect(dialog.getByRole("complementary", { name: "Search result preview" }).getByRole("heading", { name: "Lisp 与人工智能" })).toBeVisible();
  const searchInput = dialog.getByRole("textbox", { name: "Search conversations and notes" });
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
  const sidebar = page.getByRole("complementary", { name: "Conversation navigation", exact: true });

  await sidebar.getByRole("link", { name: "Library", exact: true }).click();

  await expect.poll(fixture.libraryReads).toBeGreaterThan(readsBeforeNavigation);
  await expect(sidebar.getByRole("link", { name: "导航后新增", exact: true })).toBeVisible();
});

test("uses the default Agent draft at the workspace URL and exposes creation surfaces", async ({ page }) => {
  await installShellFixture(page);
  await page.goto("/w/ws_1/app");

  await expect(page).toHaveURL(/\/w\/ws_1\/app$/);
  await expect(page.getByRole("navigation", { name: "Current conversation" })).toHaveCount(0);
  await expect(page.getByPlaceholder("Describe a task for Centaeris…")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Home", exact: true })).toHaveAttribute("aria-selected", "true");
  const privateDisclosure = page.locator(".shDisclosure");
  const privateNote = page.getByRole("link", { name: "个人笔记", exact: true });
  await expect(privateDisclosure).toHaveAttribute("open", "");
  const privateSummary = page.locator(".shDisclosureSummary");
  await expect(privateSummary).toHaveCSS("height", "30px");
  await privateSummary.hover();
  await expect(privateSummary).toHaveCSS("background-color", "color(srgb 0.12549 0.141176 0.156863 / 0.065)");
  await expect(page.getByRole("link", { name: "Add agent", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Add agent", exact: true }).locator("svg.lucide-bot")).toBeVisible();
  await expect(page.locator(".shPrimaryNav")).toHaveCSS("margin-top", "24px");
  await expect(page.getByText("我的任务", { exact: true })).toHaveCount(0);
  await privateSummary.click();
  await expect(privateDisclosure).not.toHaveAttribute("open", "");
  await expect(privateNote).not.toBeVisible();
  await privateSummary.click();
  await expect(privateNote).toBeVisible();
  await page.getByRole("button", { name: "Trash" }).click();
  await expect(page.getByRole("dialog", { name: "Trash" })).toBeVisible();
  await page.getByRole("button", { name: "Trash" }).click();
  await expect(page.getByRole("dialog", { name: "Trash" })).toHaveCount(0);
  await privateNote.click();
  await expect(page).toHaveURL(/\/w\/ws_1\/library\/note_welcome$/);
  await page.getByRole("button", { name: "Rename note" }).click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("欢迎来到 Centaeris");
  await expect(page.getByRole("textbox", { name: "Note content" })).toHaveValue("这是你的第一份私人文档。");
  await page.goto("/w/ws_1/app");

  await page.getByRole("button", { name: "Open add menu" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveCount(2);
  await expect(menu).toContainText("NoteChat");
  await expect(menu).not.toContainText("Upload materials");
  await expect(menu).not.toContainText("Agent");
  await page.locator(".workspaceChatColumn").click({ position: { x: 40, y: 40 } });
  await expect(menu).toHaveCount(0);

  await page.getByRole("button", { name: "Add new", exact: true }).click();
  const privateCreate = page.getByRole("dialog", { name: "Add private content" });
  await expect(privateCreate).toBeVisible();
  await expectViewportOverlay(page, ".shPrivateCreateBackdrop", privateCreate);
  await expect(privateCreate.getByRole("button", { name: "Blank note" })).toBeVisible();
  await expect(privateCreate.getByRole("button", { name: "Upload materials" })).toBeVisible();
  await expect(privateCreate.getByRole("heading", { name: "Templates" })).toBeVisible();
  await expect(privateCreate.locator(".shPrivateTemplateCard")).toHaveCount(8);
  await privateCreate.getByRole("button", { name: /Research notes/ }).click();
  await expect(page).toHaveURL(/\/w\/ws_1\/library\/new$/);
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Research notes");
  await expect(page.getByRole("button", { name: "Default workspace menu" })).toBeVisible();
});

test("opens the real library without a second management page", async ({ page }) => {
  await installShellFixture(page);
  await page.goto("/w/ws_1/library");

  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Personal library files", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "管理资料", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Add to private" }).click();
  await expect(page.getByRole("dialog", { name: "Add private content" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/w\/ws_1\/library\/new$/);
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("");
  await page.goto("/w/ws_1/library");

  await expect(page.getByRole("tab", { name: "Agent", exact: true }).locator("svg.lucide-bot")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Skills", exact: true }).locator("svg.lucide-layers")).toBeVisible();
  await page.getByRole("textbox", { name: "Search this library", exact: true }).fill("不会匹配代理");
  await page.getByRole("tab", { name: "Agent", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Search this library", exact: true })).toHaveValue("");
  await expect(page.getByRole("link", { name: /Centaeris/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Plugins", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Plugins", exact: true })).toHaveCount(0);

  const privateCreateTrigger = page.getByRole("button", { name: "Add new", exact: true });
  await privateCreateTrigger.click();
  const privateCreate = page.getByRole("dialog", { name: "Add private content" });
  await expect(privateCreate).toBeVisible();
  await expectViewportOverlay(page, ".shPrivateCreateBackdrop", privateCreate);
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  const privateClose = privateCreate.getByRole("button", { name: "Close add menu" });
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

  const searchTrigger = page.getByRole("button", { name: "Search conversations and notes" });
  await searchTrigger.click();
  const searchDialog = page.getByRole("dialog", { name: "Workspace search" });
  await expect(searchDialog).toBeVisible();
  await expectViewportOverlay(page, ".shSearchBackdrop", searchDialog);
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(searchDialog).toHaveCount(0);
  await expect(searchTrigger).toBeFocused();

  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  await expect(page.getByRole("table", { name: "Skills", exact: true })).toContainText("合成扩展说明");

  const trashTrigger = page.getByRole("button", { name: "Trash" });
  await trashTrigger.click();
  const trashDialog = page.getByRole("dialog", { name: "Trash" });
  await expect(trashDialog).toBeVisible();
  const triggerBox = await trashTrigger.boundingBox();
  const dialogBox = await trashDialog.boundingBox();
  expect(Math.abs(dialogBox.x - triggerBox.x - triggerBox.width - 8)).toBeLessThan(1);
  expect(Math.abs(dialogBox.y - triggerBox.y)).toBeLessThan(1);
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(trashDialog).toHaveCount(0);
});

test("shows workspace identity and logs out from the workspace menu", async ({ page }) => {
  const session = await installShellFixture(page);
  await page.goto("/w/ws_1/app");

  await page.getByRole("button", { name: "Default workspace menu" }).click();
  await expect(page.getByText("Owner", { exact: true })).toBeVisible();
  await expect(page.getByText("member@example.com", { exact: true })).toBeVisible();
  const popoverOwnsRightEdge = await page.evaluate(() => {
    const sidebar = document.querySelector(".workspaceSidebarSlot").getBoundingClientRect();
    const popover = document.querySelector(".shWsMenuPopover").getBoundingClientRect();
    return Boolean(document.elementFromPoint(sidebar.right + 4, popover.top + 16)?.closest(".shWsMenuPopover"));
  });
  expect(popoverOwnsRightEdge).toBe(true);
  session.expireSession();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("dialog", { name: "Sign in again" })).toHaveCount(0);
});

test("skips the chooser for one workspace and remembers a validated workspace switch", async ({ page }) => {
  const workspaces = [
    { id: "ws_1", name: "Default", status: "active", role: "owner" },
    { id: "ws_2", name: "Research", status: "active", role: "member" },
  ];
  await installShellFixture(page, { workspaces });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose workspace" })).toBeVisible();
  await expect(page.locator(".shWorkspaceChooser > section > p")).toHaveCount(0);
  const chooserRow = page.getByRole("link", { name: "Default Owner" });
  expect((await chooserRow.boundingBox()).height).toBeLessThanOrEqual(36);
  await chooserRow.click();

  await page.getByRole("button", { name: "Default workspace menu" }).click();
  const switcher = page.getByLabel("Switch workspace");
  await expect(switcher.locator("[aria-current=page]")).toContainText("Default");
  const researchRow = switcher.getByRole("link", { name: "Research" });
  expect((await researchRow.boundingBox()).height).toBeLessThanOrEqual(32);
  await expect(page.getByRole("link", { name: "Switch workspace" })).toHaveCount(0);
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
  await expect(page.getByRole("heading", { name: "Choose workspace" })).toHaveCount(0);
});

test("workspace chooser retains its actual empty state", async ({ page }) => {
  await installShellFixture(page, { workspaces: [] });
  await page.goto("/workspaces");
  await expect(page.getByRole("heading", { name: "Choose workspace" })).toBeVisible();
  await expect(page.getByText("Your account does not have access to any workspaces yet.", { exact: true })).toBeVisible();
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
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  } else {
    await expect(page.getByRole("dialog", { name: "Preferences", exact: true })).toBeVisible();
    await expect(page.locator("#messageDraft")).toHaveCount(0);
    expect(chatRequests).toBe(0);
  }
});
}

test("persists input preferences and keeps security in the administrator section", async ({ page }) => {
  const fixture = await installShellFixture(page);
  await page.goto("/w/ws_1/app");
  await page.getByRole("button", { name: "Default workspace menu" }).click();
  await expect(page.getByRole("link", { name: "工作区设置" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveCount(1);
  await page.getByRole("link", { name: "Settings", exact: true }).click();

  await expect(page).toHaveURL(/\/w\/ws_1\/settings\/preferences$/);
  let dialog = page.getByRole("dialog", { name: "Preferences" });
  await expect(dialog.getByRole("heading", { name: "Workspace" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Administrator" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "账户", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "功能" })).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "超级管理员" })).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: "Groups", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: "Plugins", exact: true }).locator("svg")).toHaveClass(/lucide-plug/);
  await expect(dialog.getByText("member@example.com", { exact: true })).toHaveCount(0);
  const settingsDialogBox = await dialog.boundingBox();
  const settingsCloseBox = await dialog.getByRole("button", { name: "Close", exact: true }).boundingBox();
  const contentHeadingBox = await dialog.getByRole("heading", { name: "Input options", exact: true }).boundingBox();
  expect(settingsCloseBox.x).toBeLessThan(contentHeadingBox.x);
  expect(settingsCloseBox.x - settingsDialogBox.x).toBeLessThanOrEqual(12);
  expect(settingsCloseBox.y - settingsDialogBox.y).toBeLessThanOrEqual(12);
  const preference = dialog.getByRole("switch", { name: "Use Enter to start a new line" });
  await expect(preference).not.toBeChecked();
  await preference.check();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("centaeris:composer-enter-new-line:v1:user_1"))).toBe("1");

  await dialog.getByRole("link", { name: "Security", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/ws_1\/settings\/security$/);
  dialog = page.getByRole("dialog", { name: "Security" });
  await expect(page.locator(".accountSecuritySettings > header p")).toHaveCount(0);
  await expect(dialog.getByText("At least 15 characters.", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel(/^New password/)).toHaveAttribute("minlength", "15");
  await dialog.getByLabel("Current password").fill("wrong-password");
  await dialog.getByLabel(/^New password/).fill("Replacement-Passphrase!2027");
  await dialog.getByLabel("Confirm new password").fill("Replacement-Passphrase!2027");
  await dialog.getByRole("button", { name: "Update password" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("The current password is incorrect.");

  await dialog.getByLabel("Current password").fill("correct-password");
  await dialog.getByRole("button", { name: "Update password" }).click();
  await expect(dialog.getByRole("status")).toContainText("This device stays signed in");
  expect(fixture.passwordChangePayloads.at(-1)).toEqual({
    currentPassword: "correct-password",
    newPassword: "Replacement-Passphrase!2027",
  });
  await expect(dialog.getByLabel("Current password")).toHaveValue("");
});

test("keeps account security available to members without exposing workspace management", async ({ page }) => {
  await installShellFixture(page, { workspaces: [{ id: "ws_1", name: "Default", status: "active", role: "member" }] });
  await page.goto("/w/ws_1/app");
  await page.getByRole("button", { name: "Default workspace menu" }).click();
  await expect(page.getByRole("link", { name: "工作区设置" })).toHaveCount(0);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog", { name: "Preferences" }).getByRole("link", { name: "Security", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Security" });
  await expect(dialog.getByRole("heading", { name: "Workspace" })).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: "General" })).toBeVisible();

  await page.goto("/w/ws_1/settings/general");
  await expect(page.getByRole("combobox", { name: "Language" })).toBeVisible();
});

test("creates and edits a private Agent through Django APIs", async ({ page }) => {
  const fixture = await installShellFixture(page);
  await page.goto("/w/ws_1/agents/new");
  const agentForm = page.getByRole("dialog", { name: "Create private agent" });
  await expect(agentForm).toHaveAttribute("aria-modal", "true");
  await expect(page.locator(".shSidebar")).toHaveAttribute("inert", "");
  const closeButton = agentForm.getByRole("button", { name: "Close" });
  const closeBox = await closeButton.boundingBox();
  const headingBox = await agentForm.getByRole("heading", { name: "Create private agent" }).boundingBox();
  expect(closeBox.x).toBeLessThan(headingBox.x);
  await closeButton.hover();
  await expect(closeButton).toHaveCSS("background-color", "rgb(238, 238, 236)");
  await expect(closeButton).toHaveCSS("color", "rgb(32, 36, 40)");
  await expect(page.getByRole("button", { name: "Centaeris" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "none" }).click();
  await expect(page.getByRole("button", { name: "none" })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Agent name").fill("研究助手");
  await page.getByLabel("Agent description").fill("负责资料研究");
  await closeButton.click();
  const discardPrompt = agentForm.getByRole("alert");
  await expect(discardPrompt).toContainText("Discard unsaved changes?");
  await expect(page.locator(".themeConfirmBackdrop")).toHaveCount(0);
  await expect(discardPrompt.getByRole("button", { name: "Continue editing" })).toBeFocused();
  await discardPrompt.getByRole("button", { name: "Continue editing" }).click();
  await expect(page.getByLabel("Agent name")).toHaveValue("研究助手");
  await page.getByRole("button", { name: "Edit SOUL.md" }).click();
  await expect(page.getByRole("region", { name: "Create private agent SOUL.md" })).toBeVisible();
  await expect(page.locator(".shModalBackdrop")).toHaveCount(0);
  await page.getByLabel("Agent instructions").focus();
  await expect(page.getByLabel("Agent instructions")).toHaveCSS("outline-style", "none");
  await expect.poll(() => page.locator(".shSoulDocumentPage .libraryNoteEditor").evaluate((element) => getComputedStyle(element, "::before").backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  await expect(page.locator(".shSoulDocumentPage .libraryPreviewBody.libraryNotePreview .libraryNoteEditor")).toBeVisible();
  await expect(page.locator(".shSoulDocumentTopbar, .shSoulDocumentPaper")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "SOUL.md path" })).toContainText("Agent/SOUL.mdPrivate");
  await expect(page.getByRole("heading", { name: "SOUL.md" })).toHaveCount(0);
  await expect(page.getByLabel("Agent instructions")).toHaveAttribute("placeholder", "# Identity and responsibilities\n\nDescribe how this agent should work and the boundaries it should follow…");
  await page.getByLabel("Agent instructions").fill("先核验一手资料，再给出有出处的结论。");
  await page.getByLabel("Agent instructions").press("Escape");
  await expect(page.getByRole("dialog", { name: "Create private agent" })).toBeVisible();
  await page.getByRole("button", { name: "Edit SOUL.md" }).click();
  await expect(page.getByLabel("Agent instructions")).toHaveValue("先核验一手资料，再给出有出处的结论。");
  await page.getByRole("button", { name: "Finish editing" }).click();
  await page.getByRole("button", { name: "Create agent" }).click();

  await expect(page).toHaveURL(/\/w\/ws_1\/agents\/agent_research\?new=1$/);
  await page.goto("/w/ws_1/agents/agent_research/settings");
  await expect(page.getByRole("heading", { name: "研究助手" })).toBeVisible();
  await expect(page.getByText("负责资料研究", { exact: true })).toBeVisible();
  await expect(page.getByText("先核验一手资料，再给出有出处的结论。", { exact: true })).toBeVisible();
  await expect(page.locator(".shAgentPageIcon img")).toHaveAttribute("src", "/agent-avatar-banana.png");
  await expect(page.getByText("MEMORY.md", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Edit agent" }).click();
  await page.getByRole("button", { name: "Centaeris" }).click();
  await page.getByLabel("Agent description").fill("负责深入研究与整理");
  await page.getByRole("button", { name: "Edit SOUL.md" }).click();
  await page.getByLabel("Agent instructions").fill("结论必须区分事实与推断。");
  await page.getByRole("button", { name: "Finish editing" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("负责深入研究与整理", { exact: true })).toBeVisible();
  await expect(page.getByText("结论必须区分事实与推断。", { exact: true })).toBeVisible();
  await expect(page.locator(".shAgentPageIcon img")).toHaveAttribute("src", "/centaeris-mark.png");
  await expect(page.getByText("行为边界", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Move to trash", exact: true }).click();
  await expect(page.locator(".themeConfirmDialog")).toHaveCount(0);
  await expect.poll(() => fixture.deletedAgentIds).toEqual(["agent_research"]);
  await expect(page).toHaveURL(/\/w\/ws_1\/app$/);
});

test("reauthenticates in place without losing an Agent draft or retrying its mutation", async ({ page }) => {
  const session = await installShellFixture(page);
  await page.goto("/w/ws_1/agents/new");
  await page.getByLabel("Agent name").fill("仍在页面的草稿");
  await page.getByLabel("Agent description").fill("Session 失效后不能丢失");
  session.expireSession();

  await page.getByRole("button", { name: "Create agent" }).click();
  const reauthentication = page.getByRole("dialog", { name: "Sign in again" });
  await expect(reauthentication).toBeVisible();
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  await expect(reauthentication.getByLabel("Email")).toHaveValue("member@example.com");
  await expect(reauthentication.getByLabel("Email")).toHaveAttribute("readonly", "");
  await expect(page.getByLabel("Agent name")).toHaveValue("仍在页面的草稿");
  expect(session.agentCreateAttempts()).toBe(1);

  await reauthentication.getByLabel("Password").fill("wrong-password");
  await reauthentication.getByRole("button", { name: "Sign in again" }).click();
  await expect(reauthentication.getByRole("alert")).toHaveText("Incorrect password. Please try again.");
  await expect(page.getByLabel("Agent name")).toHaveValue("仍在页面的草稿");
  await reauthentication.getByLabel("Password").fill("correct-password");
  await reauthentication.getByRole("button", { name: "Sign in again" }).click();
  const restored = page.getByRole("dialog", { name: "You are signed in again" });
  await expect(restored).toContainText("The failed action has not been retried automatically");
  await expect(page.getByLabel("Agent name")).toHaveValue("仍在页面的草稿");
  expect(session.agentCreateAttempts()).toBe(1);

  await restored.getByRole("button", { name: "Continue" }).click();
  await expect(restored).toHaveCount(0);
  await expect(page.getByLabel("Agent description")).toHaveValue("Session 失效后不能丢失");
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page).toHaveURL(/\/w\/ws_1\/agents\/agent_research\?new=1$/);
  expect(session.agentCreateAttempts()).toBe(2);
});

test("keeps a chat draft and pending file through in-place reauthentication", async ({ page }) => {
  const session = await installShellFixture(page);
  await page.goto("/w/ws_1/agents/centaeris?new=1");
  await page.getByLabel("Message", { exact: true }).fill("这段对话草稿必须保留");
  await page.getByLabel("Select one or more materials").setInputFiles({
    name: "session-draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("draft"),
  });
  session.expireSession();

  await page.getByRole("button", { name: "Input", exact: true }).click();
  const reauthentication = page.getByRole("dialog", { name: "Sign in again" });
  await expect(reauthentication).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("这段对话草稿必须保留");
  await expect(page.getByLabel("Reference materials for this conversation").getByText("session-draft.txt", { exact: true })).toBeAttached();

  await reauthentication.getByLabel("Password").fill("correct-password");
  await reauthentication.getByRole("button", { name: "Sign in again" }).click();
  await page.getByRole("dialog", { name: "You are signed in again" }).getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("这段对话草稿必须保留");
  await expect(page.getByLabel("Reference materials for this conversation").getByText("session-draft.txt", { exact: true })).toBeVisible();
});



test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("centaeris:language:v1", "en"));
});
