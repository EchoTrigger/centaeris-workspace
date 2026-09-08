const { test, expect } = require("@playwright/test");

test("system dark theme paints before the application starts and follows system changes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "system");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(25, 25, 25)");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("General theme selection persists without losing the current page", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("centaeris:language:v1", "en"));
  const responses = {
    "/api/me": { user: { id: "u1", email: "member@example.com", isSuperuser: false } },
    "/api/workspaces": { workspaces: [{ id: "ws_1", name: "Research", role: "member", status: "active" }] },
    "/api/workspaces/ws_1/agents": { agents: [] },
    "/api/workspaces/ws_1/session-projects": { projects: [] },
    "/api/workspaces/ws_1/sessions": { sessions: [] },
  };
  await page.route("http://localhost:8000/api/**", route => route.fulfill({ json: responses[new URL(route.request().url()).pathname] || {} }));
  await page.goto("/w/ws_1/settings/general");
  const theme = page.getByRole("combobox", { name: "Theme", exact: true });
  await expect(theme).toHaveValue("system");
  await theme.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("dialog", { name: "General" })).toHaveCSS("background-color", "rgb(25, 25, 25)");
  await expect(page.locator(".settingsModalPage")).toHaveCSS("background-color", "rgba(0, 0, 0, 0.55)");
  const languageBorder = await page.locator(".languageSelector select").evaluate(n => getComputedStyle(n).borderColor);
  await expect(theme).toHaveCSS("border-color", languageBorder);
  await page.screenshot({ path: testInfo.outputPath("general-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(theme).toHaveValue("dark");
  await page.reload();
  await expect(theme).toHaveValue("dark");
  await theme.selectOption("light");
  await page.screenshot({ path: testInfo.outputPath("general-light.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await theme.selectOption("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("reasoning uses 14px headings and 13px details with one process gray in both themes", async ({ page }) => {
  await page.goto("/tests/fixtures/reasoning.html");
  await page.evaluate(() => window.reasoningFixture.committedHistory());
  const toggle = page.locator(".workspaceReasoning button");
  await toggle.click();
  const content = page.locator(".workspaceReasoningBody p");
  await expect(toggle).toHaveCSS("font-size", "14px");
  await expect(content).toHaveCSS("font-size", "13px");
  await expect(content).toHaveCSS("line-height", "21px");
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    const gray = await toggle.evaluate(n => getComputedStyle(n).color);
    await expect(content).toHaveCSS("color", gray);
  }
});

test("expanded tool paths and output use the 13px detail role", async ({ page }) => {
  await page.goto("/tests/fixtures/reasoning.html");
  await page.locator(".workspaceActivityGroupRecord .workspaceActivityGroup").first().click();
  await page.locator(".activityOperationSummary").first().click();
  await expect(page.locator(".activityOperationSummary").first()).toHaveCSS("font-size", "13px");
  await expect(page.locator(".activityOperationOutput").first()).toHaveCSS("font-size", "13px");
  await expect(page.locator(".activityOperationOutput").first()).toHaveCSS("color", "rgb(107, 107, 107)");
});
