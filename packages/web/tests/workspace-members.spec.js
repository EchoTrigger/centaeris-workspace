const { test, expect } = require("@playwright/test");

const CREATED_AT = "2026-08-01T00:00:00Z";
const EXPIRES_AT = "2026-08-29T00:00:00Z";

function member(membershipId, userId, email, role) {
  return { membershipId, userId, email, role, createdAt: CREATED_AT };
}

function invitation(id, email, role = "member") {
  return { id, email, role, status: "pending", expiresAt: EXPIRES_AT, createdAt: CREATED_AT };
}

async function installWorkspaceFixture(page, { workspaceRole = "owner", loseAccessOnRoleUpdate = false, membershipRemovedOnRoleUpdate = false, roleUpdateGate = null } = {}) {
  let hasWorkspace = true;
  let members = workspaceRole === "owner"
    ? [
      member("membership_owner", "user_1", "owner@example.com", "owner"),
      member("membership_admin", "user_2", "admin@example.com", "admin"),
      member("membership_member", "user_3", "member@example.com", "member"),
    ]
    : [
      member("membership_owner", "user_2", "owner@example.com", "owner"),
      member("membership_member", "user_1", "member@example.com", "member"),
    ];
  let invitations = [invitation("invite_1", "pending@example.com")];
  const requests = [];

  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    requests.push({ path, method, body: request.postDataJSON?.() });

    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "csrf-test" } });
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "user_1", email: workspaceRole === "owner" ? "owner@example.com" : "member@example.com", isStaff: false, isSuperuser: false } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: hasWorkspace ? [{ id: "ws_1", name: "Default", description: "", status: "active", role: workspaceRole }] : [] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [] } });

    if (path === "/api/workspaces/ws_1/members" && method === "GET") return route.fulfill({ json: { members } });
    const memberMatch = path.match(/^\/api\/workspaces\/ws_1\/members\/(.+)$/);
    if (memberMatch && method === "PATCH") {
      if (loseAccessOnRoleUpdate || membershipRemovedOnRoleUpdate) {
        hasWorkspace = !membershipRemovedOnRoleUpdate;
        return route.fulfill({ status: 404, json: { error: "workspace_not_found" } });
      }
      if (roleUpdateGate) await roleUpdateGate;
      const target = members.find((item) => item.membershipId === memberMatch[1]);
      target.role = request.postDataJSON().role;
      return route.fulfill({ json: { member: target } });
    }
    if (memberMatch && method === "DELETE") {
      members = members.filter((item) => item.membershipId !== memberMatch[1]);
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/workspaces/ws_1/owner-transfer" && method === "POST") {
      const body = request.postDataJSON();
      const previousOwner = members.find((item) => item.userId === "user_1");
      const owner = members.find((item) => item.membershipId === body.targetMembershipId);
      previousOwner.role = "admin";
      owner.role = "owner";
      return route.fulfill({ json: { owner, previousOwner } });
    }

    if (path === "/api/workspaces/ws_1/invitations" && method === "GET") return route.fulfill({ json: { invitations } });
    if (path === "/api/workspaces/ws_1/invitations" && method === "POST") {
      const body = request.postDataJSON();
      const created = invitation(`invite_${invitations.length + 1}`, body.email.toLowerCase(), body.role);
      invitations = [...invitations.filter((item) => item.email !== created.email), created];
      return route.fulfill({ status: 201, json: { invitation: created, inviteUrl: `http://localhost:3000/activate#token=token_${created.id}` } });
    }
    const invitationMatch = path.match(/^\/api\/workspaces\/ws_1\/invitations\/(.+)$/);
    if (invitationMatch && method === "DELETE") {
      invitations = invitations.filter((item) => item.id !== invitationMatch[1]);
      return route.fulfill({ json: { ok: true } });
    }

    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  return { requests };
}

async function openWorkspaceSettings(page) {
  await page.goto("/w/ws_1/app");
  await page.getByRole("button", { name: "Default 工作区菜单" }).click();
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("dialog", { name: "偏好" }).getByRole("link", { name: "成员" }).click();
  await expect(page).toHaveURL(/\/w\/ws_1\/settings\/members$/);
  await expect(page.getByRole("heading", { name: "成员与权限" })).toBeVisible();
}

test("manages member roles, removal, and ownership transfer", async ({ page }) => {
  const { requests } = await installWorkspaceFixture(page);
  await openWorkspaceSettings(page);

  await expect(page.locator(".shWorkspaceSettingsHeader p")).toHaveCount(0);
  await expect(page.locator(".shWorkspaceSettingsSection").first().locator("header p")).toHaveText("3 位成员");
  await page.getByLabel("member@example.com 的角色").selectOption("admin");
  await expect(page.getByRole("status")).toContainText("member@example.com 已设为管理员");

  await page.getByRole("button", { name: "member@example.com 的成员操作" }).click();
  await page.getByRole("button", { name: "移除成员" }).click();
  const removeDialog = page.getByRole("dialog", { name: "移除成员" });
  await expect(removeDialog).toContainText("历史事实仍会保留");
  await removeDialog.getByRole("button", { name: "移除" }).click();
  await expect(page.getByText("member@example.com", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "admin@example.com 的成员操作" }).click();
  await page.getByRole("button", { name: "转让所有权" }).click();
  const transferDialog = page.getByRole("dialog", { name: "转让工作区所有权" });
  await transferDialog.getByLabel("当前密码").fill("correct horse battery staple");
  await transferDialog.getByRole("button", { name: "确认转让" }).click();
  await expect(page.getByRole("status")).toContainText("所有权已转让给 admin@example.com");

  expect(requests.find((request) => request.path.endsWith("/membership_member") && request.method === "PATCH").body).toEqual({ role: "admin" });
  expect(requests.find((request) => request.path.endsWith("/owner-transfer") && request.method === "POST").body).toEqual({
    targetMembershipId: "membership_admin",
    currentPassword: "correct horse battery staple",
  });
});

test("locks only the member row being updated", async ({ page }) => {
  let releaseRoleUpdate;
  const roleUpdateGate = new Promise((resolve) => { releaseRoleUpdate = resolve; });
  await installWorkspaceFixture(page, { roleUpdateGate });
  await openWorkspaceSettings(page);

  const memberRole = page.getByLabel("member@example.com 的角色");
  await memberRole.selectOption("admin");
  await expect(memberRole).toBeDisabled();
  await expect(page.getByLabel("admin@example.com 的角色")).toBeEnabled();

  releaseRoleUpdate();
  await expect(page.getByRole("status")).toContainText("member@example.com 已设为管理员");
});

test("shows invitation URLs once and supports reissue and revoke", async ({ page }) => {
  await installWorkspaceFixture(page);
  await openWorkspaceSettings(page);

  await page.getByRole("button", { name: "邀请成员" }).click();
  const inviteDialog = page.getByRole("dialog", { name: "邀请成员" });
  await inviteDialog.getByLabel("邮箱").fill("new@example.com");
  await inviteDialog.getByLabel("角色").selectOption("admin");
  await inviteDialog.getByRole("button", { name: "生成邀请链接" }).click();
  const resultDialog = page.getByRole("dialog", { name: "邀请链接已生成" });
  await expect(resultDialog.getByText(/token_invite_2/)).toBeVisible();
  await resultDialog.getByRole("button", { name: "完成" }).click();
  await expect(page.getByText("new@example.com", { exact: true })).toBeVisible();

  const pendingRow = page.locator(".shWorkspaceInvitationRow").filter({ hasText: "pending@example.com" });
  await pendingRow.getByRole("button", { name: "重新签发" }).click();
  await page.getByRole("dialog", { name: "重新签发邀请" }).getByRole("button", { name: "重新签发" }).click();
  await expect(page.getByRole("dialog", { name: "邀请链接已生成" })).toContainText("pending@example.com");
  await page.getByRole("dialog", { name: "邀请链接已生成" }).getByRole("button", { name: "完成" }).click();

  const reissuedRow = page.locator(".shWorkspaceInvitationRow").filter({ hasText: "pending@example.com" });
  await reissuedRow.getByRole("button", { name: "撤销" }).click();
  await page.getByRole("dialog", { name: "撤销邀请" }).getByRole("button", { name: "撤销" }).click();
  await expect(page.getByText("pending@example.com", { exact: true })).toHaveCount(0);
});

test("hides workspace management from ordinary members and rejects direct navigation", async ({ page }) => {
  await installWorkspaceFixture(page, { workspaceRole: "member" });
  await page.goto("/w/ws_1/app");
  await page.getByRole("button", { name: "Default 工作区菜单" }).click();
  await expect(page.getByRole("link", { name: "工作区设置" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "设置", exact: true })).toBeVisible();

  await page.goto("/w/ws_1/settings/members");
  await expect(page).toHaveURL(/\/w\/ws_1\/app$/);
  await expect(page.getByRole("status")).toHaveText("你没有权限访问工作区设置。");
});

test("returns home when management permission disappears during a mutation", async ({ page }) => {
  await installWorkspaceFixture(page, { loseAccessOnRoleUpdate: true });
  await openWorkspaceSettings(page);
  await page.getByLabel("member@example.com 的角色").selectOption("admin");
  await expect(page).toHaveURL(/\/w\/ws_1\/app$/);
  await expect(page.getByRole("status")).toHaveText("你已没有权限访问工作区设置。");
});

test("returns to the chooser when the current membership is removed", async ({ page }) => {
  await installWorkspaceFixture(page, { membershipRemovedOnRoleUpdate: true });
  await openWorkspaceSettings(page);
  await page.getByLabel("member@example.com 的角色").selectOption("admin");
  await expect(page).toHaveURL(/\/workspaces$/);
  await expect(page.getByRole("status")).toHaveText("你已不再是 Default 的成员。");
  await expect(page.getByText("当前账号还没有可访问的工作区。")).toBeVisible();
});
