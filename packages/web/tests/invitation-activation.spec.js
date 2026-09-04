const { test, expect } = require("@playwright/test");

const PREVIEW = {
  workspaceId: "ws_1",
  workspaceName: "Default",
  email: "invitee@example.com",
  role: "member",
  accountExists: false,
  expiresAt: "2026-08-29T00:00:00Z",
};

async function installFixture(page, { accountExists = false, previewError = "", loggedInAs = "" } = {}) {
  let loggedInEmail = loggedInAs;
  const requests = [];
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postDataJSON?.();
    requests.push({ path, method, body, url: request.url() });

    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "csrf-test" } });
    if (path === "/api/invitations/preview" && method === "POST") {
      if (body?.token !== "token_1") return route.fulfill({ status: 404, json: { error: "invitation_not_found" } });
      if (previewError) return route.fulfill({ status: previewError === "invitation_expired" ? 410 : 404, json: { error: previewError } });
      return route.fulfill({ json: { ...PREVIEW, accountExists } });
    }
    if (path === "/api/invitations/accept" && method === "POST") {
      if (accountExists && !loggedInEmail) return route.fulfill({ status: 401, json: { error: "invitation_login_required" } });
      if (loggedInEmail && loggedInEmail !== PREVIEW.email) return route.fulfill({ status: 403, json: { error: "invitation_account_mismatch" } });
      loggedInEmail = PREVIEW.email;
      return route.fulfill({ json: { workspaceId: "ws_1", membershipId: "membership_1", role: "member", userCreated: !accountExists } });
    }
    if (path === "/api/login" && method === "POST") {
      loggedInEmail = body.email;
      return route.fulfill({ json: { user: { id: loggedInEmail === PREVIEW.email ? "user_1" : "user_other", email: loggedInEmail, isStaff: false, isSuperuser: false } } });
    }
    if (path === "/api/logout" && method === "POST") {
      loggedInEmail = "";
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "user_1", email: PREVIEW.email, isStaff: false, isSuperuser: false } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "Default", status: "active", role: "member" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [] } });
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  return requests;
}

test("creates a new invited account without exposing its token in a request URL", async ({ page }) => {
  const requests = await installFixture(page);
  await page.goto("/activate#token=token_1");
  await expect(page).toHaveURL(/\/activate$/);
  await expect(page.getByRole("heading", { name: "加入 Default" })).toBeVisible();
  await expect(page.getByText("密码至少 15 个字符。", { exact: true })).toBeVisible();
  await expect(page.getByLabel("设置密码")).toHaveAttribute("minlength", "15");
  await page.getByLabel("姓名").fill("Lumi User");
  await page.getByLabel("设置密码").fill("A-strong-password-2026");
  await page.getByLabel("确认密码").fill("different-password");
  await page.getByRole("button", { name: "接受并进入工作区" }).click();
  await expect(page.getByRole("alert")).toHaveText("两次输入的密码不一致。");
  expect(requests.some((request) => request.path === "/api/invitations/accept")).toBe(false);
  await page.getByLabel("确认密码").fill("A-strong-password-2026");
  await page.getByRole("button", { name: "接受并进入工作区" }).click();
  await expect(page).toHaveURL(/\/w\/ws_1\/app$/);
  expect(requests.find((request) => request.path === "/api/invitations/accept").body).toEqual({ token: "token_1", name: "Lumi User", password: "A-strong-password-2026" });
  expect(requests.some((request) => request.url.includes("token_1"))).toBe(false);
});

test("logs an existing invited account in on the same card before accepting", async ({ page }) => {
  const requests = await installFixture(page, { accountExists: true });
  await page.goto("/activate#token=token_1");
  await page.getByRole("button", { name: "接受并进入工作区" }).click();

  await expect(page).toHaveURL(/\/activate$/);
  await expect(page.getByRole("heading", { name: "登录受邀账号", level: 2 })).toBeVisible();
  await expect(page.getByLabel("邮箱")).toHaveValue("invitee@example.com");
  await expect(page.getByLabel("邮箱")).toHaveAttribute("readonly", "");
  await page.getByLabel("密码").fill("existing-password");
  await page.getByRole("button", { name: "登录受邀账号" }).click();
  await expect(page.getByText("已登录受邀账号，请确认加入工作区。")).toBeVisible();
  await page.getByRole("button", { name: "接受并进入工作区" }).click();

  await expect(page).toHaveURL(/\/w\/ws_1\/app$/);
  expect(requests.filter((request) => request.path === "/api/invitations/accept").map((request) => request.body)).toEqual([{ token: "token_1" }, { token: "token_1" }]);
  expect(requests.some((request) => request.path === "/api/login" && request.url.includes("invitee@example.com"))).toBe(false);
});

test("offers an explicit account switch when the current account does not match", async ({ page }) => {
  const requests = await installFixture(page, { accountExists: true, loggedInAs: "other@example.com" });
  await page.goto("/activate#token=token_1");
  await page.getByRole("button", { name: "接受并进入工作区" }).click();

  await expect(page.getByRole("alert")).toContainText("当前登录账号与邀请邮箱不一致");
  await page.getByRole("button", { name: "切换到受邀账号" }).click();
  await expect(page.getByRole("heading", { name: "登录受邀账号", level: 2 })).toBeVisible();
  expect(requests.some((request) => request.path === "/api/logout")).toBe(true);
});

test("shows an expired invitation without an acceptance form", async ({ page }) => {
  await installFixture(page, { previewError: "invitation_expired" });
  await page.goto("/activate#token=token_1");
  await expect(page.getByRole("heading", { name: "无法接受邀请" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("已经过期");
  await expect(page.getByRole("button", { name: "接受并进入工作区" })).toHaveCount(0);
});

test("does not accept the removed query-string invitation format", async ({ page }) => {
  const requests = await installFixture(page);
  await page.goto("/activate?token=token_1");
  await expect(page.getByRole("heading", { name: "无法接受邀请" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("这个邀请链接缺少 token。");
  expect(requests.some((request) => request.path === "/api/invitations/preview")).toBe(false);
});
