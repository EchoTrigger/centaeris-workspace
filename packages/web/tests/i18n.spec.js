const { test, expect } = require("@playwright/test");

test("language changes preserve reasoning content and disclosure state", async ({ page }) => {
  await page.goto("/tests/fixtures/reasoning.html");
  await page.evaluate(() => window.reasoningFixture.liveSnapshot(1, "保留模型的思考内容"));
  const toggle = page.locator(".workspaceReasoning button");
  await expect(toggle).toHaveAttribute("aria-label", "正在思考");
  await toggle.click();
  await expect(toggle).toHaveText("思考");
  await page.getByRole("combobox", { name: "语言" }).selectOption("en");
  await expect(toggle).toHaveText("Thoughts");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("region")).toHaveText("保留模型的思考内容");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", "Thinking");
  await expect(page.locator(".reasoningPreviewText")).toHaveText("保留模型的思考内容");
});

test("first visit defaults to Chinese", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
});

test("members can change language in General without losing workspace content", async ({ page }, testInfo) => {
  const responses = {
    "/api/me": { user: { id: "user_1", email: "member@example.com", isStaff: false, isSuperuser: false } },
    "/api/workspaces": { workspaces: [{ id: "ws_1", name: "研究工作区", status: "active", role: "member" }] },
    "/api/workspaces/ws_1/agents": { agents: [] },
    "/api/workspaces/ws_1/session-projects": { projects: [] },
    "/api/workspaces/ws_1/sessions": { sessions: [] },
    "/api/library": { objects: [] },
  };
  await page.route("http://localhost:8000/api/**", (route) => {
    const data = responses[new URL(route.request().url()).pathname];
    return data ? route.fulfill({ json: data }) : route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.goto("/w/ws_1/settings/general");
  const general = page.getByRole("dialog", { name: "通用", exact: true });
  await expect(general).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("general-chinese.png") });
  await general.getByRole("combobox", { name: "语言", exact: true }).selectOption("en");
  await expect(page.getByRole("dialog", { name: "General", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("general-english.png") });
  await expect(page.getByRole("link", { name: "Members", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("dialog", { name: "General", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("button", { name: "研究工作区 workspace menu" })).toBeVisible();
});

test("an existing sign-in error follows language changes without clearing the form", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("centaeris:language:v1", "en"));
  await page.route("http://localhost:8000/api/**", (route) => new URL(route.request().url()).pathname === "/api/csrf"
    ? route.fulfill({ json: { csrfToken: "test" } })
    : route.fulfill({ status: 401, json: { error: "invalid_credentials" } }));
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill("draft@example.com");
  await page.getByLabel("Password", { exact: true }).fill("incorrect-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Incorrect email or password.");
  await page.getByRole("combobox", { name: "Language" }).selectOption("zh-CN");
  await expect(page.getByRole("alert")).toHaveText("邮箱或密码不正确。");
  await expect(page.getByLabel("邮箱")).toHaveValue("draft@example.com");
});

test("changing language preserves the draft and survives reload", async ({ page }) => {
  await page.addInitScript(() => { if (!localStorage.getItem("centaeris:language:v1")) localStorage.setItem("centaeris:language:v1", "en"); });
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByLabel("Email", { exact: true }).fill("draft@example.com");
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("zh-CN");
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
  await expect(page.getByLabel("邮箱", { exact: true })).toHaveValue("draft@example.com");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.reload();
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "语言", exact: true }).selectOption("en");
  await expect(page.getByRole("link", { name: "Forgot password?" })).toBeVisible();
});

test("invalid saved language falls back to Chinese", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("centaeris:language:v1", "unsupported"));
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
});
