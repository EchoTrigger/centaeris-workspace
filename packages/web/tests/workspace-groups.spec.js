const { test, expect } = require("@playwright/test");

const CREATED_AT = "2026-08-01T00:00:00Z";
const member = (membershipId, userId, email, role) => ({ membershipId, userId, email, role, createdAt: CREATED_AT });
const group = (id, name, kind = "custom") => ({ id, name, kind, createdAt: CREATED_AT });

async function installFixture(page) {
  let groups = [group("group_all", "全体成员", "all_members"), group("group_ops", "Operations")];
  const members = [member("membership_owner", "user_1", "owner@example.com", "owner"), member("membership_member", "user_2", "member@example.com", "member")];
  const rosters = new Map([["group_all", new Set(members.map((item) => item.membershipId))], ["group_ops", new Set(["membership_member"])] ]);
  const requests = [];
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    requests.push({ path, method, body: request.postDataJSON?.() });
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "csrf-test" } });
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "user_1", email: "owner@example.com", isStaff: false, isSuperuser: false } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "Default", status: "active", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [] } });
    if (path === "/api/workspaces/ws_1/members" && method === "GET") return route.fulfill({ json: { members } });
    if (path === "/api/workspaces/ws_1/groups" && method === "GET") return route.fulfill({ json: { groups } });
    if (path === "/api/workspaces/ws_1/groups" && method === "POST") {
      const created = group("group_new", request.postDataJSON().name.trim());
      groups = [...groups, created];
      rosters.set(created.id, new Set());
      return route.fulfill({ status: 201, json: { group: created } });
    }
    const groupMatch = path.match(/^\/api\/workspaces\/ws_1\/groups\/([^/]+)$/);
    if (groupMatch && method === "PATCH") {
      const target = groups.find((item) => item.id === groupMatch[1]);
      target.name = request.postDataJSON().name.trim();
      return route.fulfill({ json: { group: target } });
    }
    if (groupMatch && method === "DELETE") {
      groups = groups.filter((item) => item.id !== groupMatch[1]);
      return route.fulfill({ json: { ok: true } });
    }
    const rosterMatch = path.match(/^\/api\/workspaces\/ws_1\/groups\/([^/]+)\/members(?:\/([^/]+))?$/);
    if (rosterMatch && method === "GET") return route.fulfill({ json: { members: members.filter((item) => rosters.get(rosterMatch[1]).has(item.membershipId)) } });
    if (rosterMatch && ["PUT", "DELETE"].includes(method)) {
      if (method === "PUT") rosters.get(rosterMatch[1]).add(rosterMatch[2]);
      else rosters.get(rosterMatch[1]).delete(rosterMatch[2]);
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  return requests;
}

test("creates, renames, assigns, and deletes a custom group", async ({ page }) => {
  const requests = await installFixture(page);
  await page.goto("/w/ws_1/settings/groups");
  await page.getByRole("button", { name: "新建用户组" }).click();
  await page.getByLabel("新用户组名称").fill("Finance");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Finance" })).toBeVisible();
  await expect(page.locator(".shWorkspaceSettingsHeader p")).toHaveCount(0);
  await expect(page.locator(".shWorkspaceGroupDetail > header p")).toHaveText("0 位成员");

  await page.getByRole("button", { name: "重命名" }).click();
  await page.getByLabel("用户组名称").fill("Finance team");
  await page.getByRole("button", { name: "保存" }).click();
  await page.getByText("owner@example.com").click();
  await expect.poll(() => requests.some((request) => request.method === "PUT" && request.path.endsWith("/membership_owner"))).toBe(true);

  await page.getByRole("button", { name: "删除 Finance team" }).click();
  await page.getByRole("dialog", { name: "删除用户组" }).getByRole("button", { name: "删除" }).click();
  await expect(page.getByRole("button", { name: /Finance team/ })).toHaveCount(0);
});

test("keeps all-members dynamic and immutable", async ({ page }) => {
  await installFixture(page);
  await page.goto("/w/ws_1/settings/groups");
  await page.getByRole("button", { name: /全体成员/ }).click();
  await expect(page.getByText("自动包含所有当前有效成员。", { exact: true })).toBeVisible();
  await expect(page.getByLabel("用户组名称")).toHaveCount(0);
  await expect(page.locator(".shWorkspaceGroupMembers input:checked")).toHaveCount(2);
  await expect(page.locator(".shWorkspaceGroupMembers input:enabled")).toHaveCount(0);
});
