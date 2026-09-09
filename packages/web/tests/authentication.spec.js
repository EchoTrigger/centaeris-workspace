const { test, expect } = require("@playwright/test");

async function installAuthFixture(page, { status = 401, error = "authentication_required" } = {}) {
  let loggedIn = false;
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "csrf-test" } });
    if (path === "/api/login" && request.method() === "POST") {
      loggedIn = true;
      return route.fulfill({ json: { user: { id: "user_1", email: "owner@example.com", isStaff: false, isSuperuser: false } } });
    }
    if (path === "/api/me") {
      return loggedIn
        ? route.fulfill({ json: { user: { id: "user_1", email: "owner@example.com", isStaff: false, isSuperuser: false } } })
        : route.fulfill({ status, json: { error } });
    }
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "Default", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [] } });
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });
}

test("returns an anonymous deep link after login", async ({ page }) => {
  await installAuthFixture(page);
  await page.goto("/w/ws_1/settings/general?source=deep-link");

  await expect(page).toHaveURL(/\/login\?/);
  expect(new URL(page.url()).searchParams.get("next")).toBe("/w/ws_1/settings/general?source=deep-link");

  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("correct-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page).toHaveURL(/\/w\/ws_1\/settings\/general\?source=deep-link$/);
  await expect(page.getByRole("dialog", { name: "General" })).toBeVisible();
});

for (const response of [
  { status: 401, error: "invalid_credentials" },
  { status: 403, error: "superuser_required" },
]) {
  test(`does not treat ${response.status} ${response.error} as an expired session`, async ({ page }) => {
    await installAuthFixture(page, response);
    await page.goto("/w/ws_1/settings/general");

    await expect(page).toHaveURL(/\/w\/ws_1\/settings\/general$/);
    await expect(page.getByRole("heading", { name: "This page could not be loaded" })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("If reloading does not help");
  });
}

test("requests a reset link without revealing whether the account exists", async ({ page }) => {
  let requestBody;
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "csrf-test" } });
    if (path === "/api/account/password-reset-requests" && request.method() === "POST") {
      requestBody = request.postDataJSON();
      return route.fulfill({ status: 202, json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/login");
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await expect(page.getByRole("heading", { name: "Reset password" })).toBeVisible();
  await page.getByLabel("Email").fill("member@example.com");
  const [response] = await Promise.all([
    page.waitForResponse((item) => item.request().method() === "POST"
      && new URL(item.url()).pathname === "/api/account/password-reset-requests"),
    page.getByRole("button", { name: "Send reset link" }).click(),
  ]);

  expect(response.status()).toBe(202);
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("If this email belongs to an available account");
  expect(requestBody).toEqual({ email: "member@example.com" });
});

test("resets a password from a fragment token and removes it from the address", async ({ page }) => {
  let resetBody;
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "csrf-test" } });
    if (path === "/api/account/password-resets" && request.method() === "POST") {
      resetBody = request.postDataJSON();
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/reset-password#uid=dXNlcl8x&token=reset-token");
  await expect(page).toHaveURL(/\/reset-password$/);
  await page.getByLabel("New password", { exact: true }).fill("Replacement-Passphrase!2027");
  await page.getByLabel("Enter new password again").fill("Replacement-Passphrase!2027");
  await page.getByRole("button", { name: "Update password" }).click();

  await expect(page).toHaveURL(/\/login\?reset=1$/);
  await expect(page.getByRole("status")).toHaveText("Your password has been updated. Sign in with your new password.");
  expect(resetBody).toEqual({
    uid: "dXNlcl8x",
    token: "reset-token",
    newPassword: "Replacement-Passphrase!2027",
  });
});

test("shows when password reset email is not configured", async ({ page }) => {
  await page.route("http://localhost:8000/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "csrf-test" } });
    if (path === "/api/account/password-reset-requests") {
      return route.fulfill({ status: 503, json: { error: "account_password_reset_unavailable" } });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill("member@example.com");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("alert")).toHaveText("Email is not configured. Contact your administrator to reset your password.");
});



test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("centaeris:language:v1", "en"));
});
