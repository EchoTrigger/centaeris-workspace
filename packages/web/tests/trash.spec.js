const { test, expect } = require("@playwright/test");

test("trash groups current Workspace data with the global private Library", async ({ page }) => {
  const restored = [];
  const purged = [];
  const purgeRequests = [];
  const activeAgent = { id: "agent_active", workspaceId: "ws_1", name: "Active", description: "", avatarKind: "centaeris", status: "active", deletedAt: null };
  const deletedAgent = { id: "agent_deleted", workspaceId: "ws_1", name: "Deleted Agent", description: "", avatarKind: "centaeris", status: "deleted", deletedAt: "2026-08-20T00:00:00Z" };
  const deletedAgent2 = { ...deletedAgent, id: "agent_deleted_2", name: "Older Agent", deletedAt: "2026-08-19T00:00:00Z" };
  const deletedSession = { id: "sess_deleted", workspaceId: "ws_1", agentId: "agent_active", title: "某市一所公办中学规定：学生在校期间一律不得携带手机", origin: "user", status: "deleted", deletedAt: "2026-08-21T00:00:00Z", isPinned: false, isUnread: false, hasActiveAgentRun: false, updatedAt: "2026-08-21T00:00:00Z" };
  const childSession = { ...deletedSession, id: "sess_child", agentId: "agent_deleted", title: "随 Agent 隐藏", status: "active", deletedAt: null };
  const deletedChild = { ...deletedSession, id: "sess_deleted_child", agentId: "agent_deleted", title: "单独删除的子会话" };
  const deletedSource = { id: "source_deleted", workspaceId: "ws_1", sourceType: "fileTree", name: "Deleted Source", status: "deleted", failureReason: "", accessLevel: "control", deletedAt: "2026-08-17T00:00:00Z" };
  const actor = { userId: "user_1", email: "member@example.com" };
  const workspaceLocation = { kind: "workspace", id: null, label: "Default", scope: "workspace" };
  const agentLocation = { kind: "agent", id: "agent_active", label: "Active", scope: "workspace" };
  const libraryLocation = { kind: "libraryRoot", id: null, label: "私人", scope: "privateLibrary" };
  const trashItems = [
    { id: deletedSession.id, kind: "session", title: deletedSession.title, deletedAt: deletedSession.deletedAt, expiresAt: "2026-09-20T00:00:00Z", scope: "workspace", location: agentLocation, deletedBy: actor },
    { id: deletedAgent.id, kind: "agent", title: deletedAgent.name, deletedAt: deletedAgent.deletedAt, expiresAt: "2026-09-19T00:00:00Z", scope: "workspace", location: workspaceLocation, deletedBy: actor },
    { id: deletedAgent2.id, kind: "agent", title: deletedAgent2.name, deletedAt: deletedAgent2.deletedAt, expiresAt: "2026-09-18T00:00:00Z", scope: "workspace", location: workspaceLocation, deletedBy: actor },
    { id: "library_deleted", kind: "library", title: "私人资料.md", deletedAt: "2026-08-18T00:00:00Z", expiresAt: "2026-09-17T00:00:00Z", scope: "privateLibrary", location: libraryLocation, deletedBy: actor },
    { id: deletedSource.id, kind: "source", title: deletedSource.name, deletedAt: deletedSource.deletedAt, expiresAt: "2026-09-16T00:00:00Z", scope: "workspace", location: workspaceLocation, deletedBy: actor },
  ];
  let agents = [activeAgent];

  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "DELETE" && path.endsWith("/trash")) purgeRequests.push(path);
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "test-token" } });
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "user_1", email: "member@example.com" } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "Default", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents" && request.method() === "GET") return route.fulfill({ json: { agents } });
    if (path === "/api/models") return route.fulfill({ json: { models: [] } });
    if (path === "/api/workspaces/ws_1/session-projects") return route.fulfill({ json: { projects: [] } });
    if (path === "/api/workspaces/ws_1/sessions") return route.fulfill({ json: { sessions: [] } });
    if (path === "/api/workspaces/ws_1/trash") {
      let items = trashItems.filter((item) => !restored.includes(item.kind) && !purged.includes(item.kind));
      if (url.searchParams.get("kind")) items = items.filter((item) => item.kind === url.searchParams.get("kind"));
      if (url.searchParams.get("scope")) items = items.filter((item) => item.scope === url.searchParams.get("scope"));
      if (url.searchParams.get("query")) items = items.filter((item) => item.title.toLowerCase().includes(url.searchParams.get("query").toLowerCase()));
      return route.fulfill({ json: { items, filterOptions: { deletedBy: [actor], locations: [workspaceLocation, agentLocation, libraryLocation] }, nextCursor: null, hasMore: false } });
    }
    if (path === "/api/agents/agent_deleted/trash/sessions") return route.fulfill({ json: { sessions: [childSession, deletedChild], nextCursor: null, hasMore: false } });
    if (path === "/api/sessions/sess_deleted/history") return route.fulfill({ json: { schema: "session.history.page.v1", session: deletedSession, agentRuns: [], nextCursor: null, hasMore: false } });
    if (path === "/api/sessions/sess_deleted/assets") return route.fulfill({ json: { assets: [] } });
    if (path === "/api/sessions/sess_deleted/restore" && request.method() === "POST") {
      restored.push("session");
      return route.fulfill({ json: { session: { ...deletedSession, status: "active", deletedAt: null } } });
    }
    if (path === "/api/agents/agent_deleted/restore" && request.method() === "POST") {
      restored.push("agent");
      agents = [...agents, { ...deletedAgent, status: "active", deletedAt: null }];
      return route.fulfill({ json: { agent: agents.at(-1) } });
    }
    if (path === "/api/workspaces/ws_1/sources/source_deleted/restore" && request.method() === "POST") {
      restored.push("source");
      return route.fulfill({ json: { source: { ...deletedSource, status: "ready" } } });
    }
    if (path === "/api/workspaces/ws_1/sources/source_deleted/trash" && request.method() === "DELETE") {
      purged.push("source");
      return route.fulfill({ json: { source: { ...deletedSource, purgedAt: "2026-08-27T00:00:00Z" } } });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/app");
  await page.getByRole("button", { name: "垃圾桶" }).click();
  await expect(page.getByRole("dialog", { name: "垃圾桶" })).toBeVisible();
  await expect(page).toHaveURL(/\/w\/ws_1\/app$/);
  await expect(page.getByText("项目在垃圾桶中保留 30 天，之后自动删除。", { exact: true })).toBeVisible();
  await page.locator(".workspaceTopbar").click();
  await expect(page.getByRole("dialog", { name: "垃圾桶" })).toHaveCount(0);
  await page.getByRole("button", { name: "垃圾桶" }).click();
  await expect(page.getByRole("heading", { name: /会话|代理|工作区资料|私人资料/ })).toHaveCount(0);
  await expect(page.getByText("私人资料.md", { exact: true })).toBeVisible();
  await expect(page.getByText("Deleted Source", { exact: true })).toBeVisible();
  await expect(page.getByText("Older Agent", { exact: true })).toBeVisible();
  await page.getByLabel("类型").selectOption("library");
  await expect(page.getByText("私人资料.md", { exact: true })).toBeVisible();
  await expect(page.getByText("Deleted Source", { exact: true })).toHaveCount(0);
  await page.getByLabel("类型").selectOption("");
  await page.getByLabel("搜索垃圾桶").fill("Deleted Source");
  await expect(page.getByText("Deleted Source", { exact: true })).toBeVisible();
  await expect(page.getByText("私人资料.md", { exact: true })).toHaveCount(0);
  await page.getByLabel("搜索垃圾桶").fill("");
  await expect(page.getByText("Deleted Agent", { exact: true })).toBeVisible();
  await page.locator(".shTrashRow").filter({ hasText: "私人资料.md" }).getByRole("button", { name: "永久删除私人资料.md" }).click();
  await expect(page.getByRole("dialog", { name: "确定要删除此资料？" })).toBeVisible();
  await page.getByRole("dialog", { name: "确定要删除此资料？" }).getByRole("button", { name: "取消", exact: true }).click();
  await page.locator(".shTrashRow").filter({ hasText: "Older Agent" }).getByRole("button", { name: "永久删除Older Agent" }).click();
  await expect(page.getByRole("dialog", { name: "确定要删除此代理及其对话？" })).toBeVisible();
  await page.getByRole("dialog", { name: "确定要删除此代理及其对话？" }).getByRole("button", { name: "取消", exact: true }).click();
  expect(purgeRequests).toEqual([]);
  await page.getByRole("button", { name: /^Deleted Agent/ }).click();
  await expect(page.getByRole("link", { name: /随 Agent 隐藏/ })).toBeVisible();
  await expect(page.getByText("单独删除的子会话", { exact: true })).toBeVisible();

  await page.locator(".shTrashRow").filter({ hasText: deletedSession.title }).getByRole("button", { name: `永久删除${deletedSession.title}` }).click();
  const sessionDialog = page.getByRole("dialog", { name: "确定要删除此对话？" });
  await expect(sessionDialog).toBeVisible();
  await expect(sessionDialog.locator("p")).toHaveCount(0);
  await expect(sessionDialog.getByRole("button", { name: "取消", exact: true })).toBeVisible();
  await expect(sessionDialog.getByRole("button", { name: "确认", exact: true })).toBeVisible();
  await sessionDialog.getByRole("button", { name: "取消", exact: true }).click();
  expect(purgeRequests).toEqual([]);

  await page.locator(".shTrashRow").filter({ hasText: "Deleted Source" }).getByRole("button", { name: "永久删除Deleted Source" }).click();
  const sourceDialog = page.getByRole("dialog", { name: "确定要删除此来源？" });
  await expect(sourceDialog).toBeVisible();
  await expect(sourceDialog.locator("p")).toHaveCount(0);
  await sourceDialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByText("Deleted Source", { exact: true })).toHaveCount(0);
  expect(purged).toEqual(["source"]);
  expect(purgeRequests).toEqual(["/api/workspaces/ws_1/sources/source_deleted/trash"]);

  await page.getByRole("link", { name: /某市一所公办中学规定/ }).click();
  await expect(page.getByText(/此会话已被移到垃圾桶，还剩 \d+ 天。/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "输入消息" })).toHaveCount(0);
  await page.getByRole("button", { name: "永久删除", exact: true }).click();
  const routeDialog = page.getByRole("dialog", { name: "确定要删除此对话？" });
  await expect(routeDialog).toBeVisible();
  await expect(routeDialog.locator("p")).toHaveCount(0);
  await routeDialog.getByRole("button", { name: "取消", exact: true }).click();
  expect(purgeRequests).toEqual(["/api/workspaces/ws_1/sources/source_deleted/trash"]);
  await page.getByRole("button", { name: "恢复会话" }).click();
  await expect(page).toHaveURL(/\/w\/ws_1\/agents\/agent_active\?sessionId=sess_deleted$/);
  expect(restored).toContain("session");
});
