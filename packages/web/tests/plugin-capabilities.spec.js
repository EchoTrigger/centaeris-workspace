const { test, expect } = require("@playwright/test");

test("workspace uses separate Plugin and direct Skill APIs", async ({ page }) => {
  let enabled = false;
  let enablementBody;
  let skillDetailRequests = 0;
  const skill = {
    skillId: "plugin-banana-0:banana",
    name: "banana",
    description: "Synthetic extension fixture.",
    enabled: true,
    allowImplicitInvocation: true,
    allowedTools: ["read", "bash"],
  };
  const plugin = () => ({
    name: "banana",
    displayName: "Banana Extension",
    shortDescription: "Synthetic extension fixture.",
    capabilities: ["Word", "Excel", "PowerPoint", "PDF"],
    version: "1.0.0",
    packageDigest: `sha256:${"a".repeat(64)}`,
    enabled,
    errors: [],
    skills: [{ path: "skills/banana/SKILL.md", digest: `sha256:${"b".repeat(64)}` }],
    cli: [{ path: "bin/banana", digest: `sha256:${"c".repeat(64)}` }],
    mcpServers: [],
    mcpCredentialRefs: [],
    hooks: [{ id: "guard-write", event: "PreToolUse", matcher: "write", timeoutMs: 5000 }],
  });
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "1", email: "member@example.com", isStaff: false, isSuperuser: false } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "默认工作区", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [] } });
    if (path === "/api/workspaces/ws_1/sessions") return route.fulfill({ json: { sessions: [] } });
    if (path === "/api/models") return route.fulfill({ json: { models: [] } });
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "csrf-test-token" } });
    if (path === "/api/workspaces/ws_1/plugins" && request.method() === "GET") return route.fulfill({ json: { plugins: [plugin()] } });
    if (path === "/api/workspaces/ws_1/plugins/banana" && request.method() === "GET") return route.fulfill({ json: { plugin: plugin() } });
    if (path === "/api/workspaces/ws_1/plugins/banana" && request.method() === "PATCH") {
      enablementBody = request.postDataJSON();
      enabled = enablementBody.enabled;
      return route.fulfill({ json: { plugin: plugin() } });
    }
    if (path === "/api/workspaces/ws_1/skills" && request.method() === "GET") {
      return route.fulfill({ json: { schema: "workspace.skill.catalog.result.v1", skills: enabled ? [skill] : [] } });
    }
    if (path.startsWith("/api/workspaces/ws_1/skills/") && request.method() === "GET") {
      skillDetailRequests += 1;
      return route.fulfill({ json: {
        schema: "workspace.skill.detail.result.v1",
        skill,
        content: "# 文档创作\n\n- 创建并检查文档\n- 需要时使用 `read`",
      } });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/settings/plugins");
  await expect(page.getByRole("dialog", { name: "工作空间插件" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "工作空间插件", exact: true })).toBeVisible();
  await expect(page.locator(".workspaceSettingsFeature > header > p")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重新检查插件", exact: true })).toHaveCount(0);
  await expect(page.getByText("Banana Extension", { exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic extension fixture.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Lifecycle Hooks" })).toHaveCount(0);
  await page.getByRole("button", { name: "查看 Banana Extension 详细信息" }).click();
  await expect(page.getByText("Word、Excel、PowerPoint、PDF", { exact: true })).toBeVisible();
  await expect(page.locator(".pluginSettingsProperty small")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Lifecycle Hooks" })).toHaveCount(0);
  await page.getByText("开发者信息", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Lifecycle Hooks" })).toBeVisible();
  await expect(page.getByText("guard-write", { exact: true })).toBeVisible();
  await expect(page.getByText("write", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "启用 Banana Extension" }).click();
  await expect(page.getByRole("button", { name: "停用 Banana Extension" })).toHaveText("已启用");
  expect(enablementBody).toEqual({ enabled: true });
  await expect(page.getByRole("link", { name: "Skills", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "关闭" }).click();
  await page.goto("/w/ws_1/library?view=skills");
  await expect(page.getByRole("table", { name: "Skills" })).toContainText("banana");
  await expect(page.getByRole("table", { name: "Skills" })).toContainText("自动");
  await expect(page.getByRole("heading", { name: "文档创作" })).toHaveCount(0);
  expect(skillDetailRequests).toBe(0);
  const libraryWidth = (await page.locator(".libraryMain").boundingBox()).width;
  await page.getByRole("row", { name: "预览 banana", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Skill 预览" })).toBeVisible();
  await page.waitForTimeout(400);
  expect((await page.locator(".libraryMain").boundingBox()).width).toBeLessThan(libraryWidth);
  await expect(page.getByRole("heading", { name: "文档创作" })).toBeVisible();
  await expect(page.getByText("创建并检查文档", { exact: true })).toBeVisible();
  const closeButton = page.getByRole("button", { name: "关闭 Skill 预览" });
  const closeBox = await closeButton.boundingBox();
  const titleBox = await page.locator(".librarySkillPeek > header").getByText("Skill", { exact: true }).boundingBox();
  expect(closeBox.x).toBeLessThan(titleBox.x);
  await closeButton.hover();
  await expect(closeButton).toHaveCSS("background-color", "rgb(233, 233, 230)");
  await expect(closeButton).toHaveCSS("color", "rgb(55, 53, 47)");
  expect(skillDetailRequests).toBe(1);
  await expect(page.getByText("/opt/centaeris/plugins/banana/skills/banana/SKILL.md", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Capabilities" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: "Skill 预览" })).toBeHidden();
});

for (const prefix of ["", "Bearer "]) {
test(`superuser manages one Plugin credential input (${prefix ? "prefixed" : "bare"} Token)`, async ({ page }) => {
  let credential = null;
  let createdBody = null;
  let rotatedBody = null;
  const plugin = () => ({
    name: "banana",
    displayName: "Banana Extension",
    shortDescription: "Synthetic extension with a generic MCP.",
    capabilities: ["Synthetic capability", "Fixture review"],
    version: "1.0.0",
    packageDigest: `sha256:${"a".repeat(64)}`,
    enabled: false,
    errors: [],
    skills: [{ path: "skills/banana-skill/SKILL.md", digest: `sha256:${"b".repeat(64)}` }],
    cli: [],
    hooks: [],
    mcpCredentialRefs: ["banana-token"],
    mcpServers: [{
      id: "banana-source",
      modelContractDigest: `sha256:${"c".repeat(64)}`,
      transport: { type: "streamableHttp", endpoint: "https://banana.invalid/mcp" },
      auth: { type: "bearer", credentialRef: "banana-token", credentialConfigured: Boolean(credential) },
      startupTimeoutMs: 15000,
      toolTimeoutMs: 60000,
      tools: [{ sourceName: "search_article", name: "banana_search", description: "Search bananas.", inputSchema: { type: "object" }, concurrencySafe: true, scopes: ["banana:read"] }],
    }],
  });
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "1", email: "admin@example.com", isStaff: true, isSuperuser: true } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "默认工作区", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [] } });
    if (path === "/api/workspaces/ws_1/sessions") return route.fulfill({ json: { sessions: [] } });
    if (path === "/api/models") return route.fulfill({ json: { models: [] } });
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "csrf-test-token" } });
    if (path === "/api/workspaces/ws_1/plugins") return route.fulfill({ json: { plugins: [plugin()] } });
    if (path === "/api/workspaces/ws_1/plugins/banana") return route.fulfill({ json: { plugin: plugin() } });
    if (path === "/api/admin/mcp-bearer-credentials" && request.method() === "GET") {
      return route.fulfill({ json: { credentials: credential ? [credential] : [] } });
    }
    if (path === "/api/admin/mcp-bearer-credentials" && request.method() === "POST") {
      createdBody = request.postDataJSON();
      credential = { id: "mcp_1", pluginName: createdBody.pluginName, credentialRef: createdBody.credentialRef, displayName: createdBody.displayName, version: 1 };
      return route.fulfill({ status: 201, json: { credential } });
    }
    if (path === "/api/admin/mcp-bearer-credentials/mcp_1/rotate" && request.method() === "POST") {
      rotatedBody = request.postDataJSON();
      credential = { ...credential, version: 2 };
      return route.fulfill({ json: { credential } });
    }
    if (path === "/api/admin/mcp-bearer-credentials/mcp_1" && request.method() === "DELETE") {
      credential = null;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/settings/plugins");
  await page.getByRole("button", { name: "查看 Banana Extension 详细信息" }).click();
  await expect(page.getByText("需要凭证", { exact: true })).toBeVisible();
  await page.getByText("开发者信息", { exact: true }).click();
  await expect(page.getByText("https://banana.invalid/mcp", { exact: true })).toBeVisible();
  await expect(page.getByText("banana_search", { exact: true })).toBeVisible();
  await expect(page.getByText("search_article", { exact: true })).toBeVisible();
  await expect(page.getByLabel("banana-token 显示名称")).toHaveCount(0);
  await expect(page.locator(".pluginCredentialForm input")).toHaveCount(1);
  await expect(page.getByLabel("新凭据引用", { exact: true })).toHaveCount(0);
  await expect(page.getByText("支持粘贴纯 Token 或 Bearer Token（带 Bearer 前缀）。", { exact: true })).toHaveCount(0);
  await page.getByLabel("banana-token Bearer Token").fill(`${prefix}first-secret`);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("已配置 · v1", { exact: true })).toBeVisible();
  expect(createdBody).toEqual({
    pluginName: "banana",
    credentialRef: "banana-token",
    displayName: "banana · banana-token",
    secret: `${prefix}first-secret`,
  });

  await expect(page.getByLabel("banana-token Bearer Token")).toHaveValue("");
  await page.getByLabel("banana-token Bearer Token").fill(`${prefix}replacement-secret`);
  await page.getByRole("button", { name: "轮换" }).click();
  await expect(page.getByText("已配置 · v2", { exact: true })).toBeVisible();
  expect(rotatedBody).toEqual({ secret: `${prefix}replacement-secret` });
  await expect(page.getByLabel("banana-token Bearer Token")).toHaveValue("");
  await page.getByRole("button", { name: "删除" }).click();
  const dialog = page.getByRole("dialog", { name: "删除 Bearer 凭证？" });
  await dialog.getByRole("button", { name: "删除" }).click();
  await expect(page.getByText("尚未配置", { exact: true })).toBeVisible();
});
}

for (const width of [768, 1280]) {
test(`Plugin details expand in place and dismiss outside (${width}px)`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  let enabled = false;
  let finishEnablement;
  const enablementReady = new Promise((resolve) => { finishEnablement = resolve; });
  const plugin = (name) => ({
    name, displayName: name, shortDescription: "A long plugin description. ".repeat(12),
    capabilities: ["Document review"], version: "1.0.0", packageDigest: `sha256:${"a".repeat(64)}`,
    enabled: name === "kiwi" && enabled, skills: [], cli: [], hooks: [], errors: [],
    mcpCredentialRefs: name === "kiwi" ? ["kiwi-token"] : [],
    mcpServers: name === "kiwi" ? Array.from({ length: 9 }, (_, index) => ({
      id: `kiwi-${index}`, transport: { type: "streamableHttp", endpoint: "https://kiwi.invalid/mcp" },
      auth: { type: "bearer", credentialRef: "kiwi-token", credentialConfigured: false }, tools: [],
    })) : [],
  });
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "1", email: "admin@example.com", isSuperuser: true } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "Layout", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [] } });
    if (path === "/api/workspaces/ws_1/sessions") return route.fulfill({ json: { sessions: [] } });
    if (path === "/api/models") return route.fulfill({ json: { models: [] } });
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "synthetic-csrf" } });
    if (path === "/api/admin/mcp-bearer-credentials") return route.fulfill({ json: { credentials: [] } });
    if (path === "/api/workspaces/ws_1/plugins") return route.fulfill({ json: { plugins: [plugin("banana"), plugin("kiwi")] } });
    if (path === "/api/workspaces/ws_1/plugins/banana") return route.fulfill({ json: { plugin: plugin("banana") } });
    if (path === "/api/workspaces/ws_1/plugins/kiwi") {
      if (request.method() === "PATCH") {
        expect(request.postDataJSON()).toEqual({ enabled: true });
        await enablementReady;
        enabled = true;
      }
      return route.fulfill({ json: { plugin: plugin("kiwi") } });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/settings/plugins");
  const bananaToggle = page.getByRole("button", { name: "查看 banana 详细信息", exact: true });
  const kiwiToggle = page.getByRole("button", { name: "查看 kiwi 详细信息", exact: true });
  const bananaAction = page.getByRole("button", { name: "启用 banana", exact: true });
  const kiwiAction = page.locator(".pluginSettingsEntry").nth(1).locator(".pluginEnableButton");
  await expect(kiwiAction).toBeEnabled();
  const actionNode = await kiwiAction.elementHandle();
  const measurements = [];
  async function unchanged(label, button, before) {
    const after = await button.boundingBox();
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, Math.abs(after[key] - before[key])]));
    measurements.push({ label, before, after, delta });
    for (const value of Object.values(delta)) expect(value, label).toBeLessThanOrEqual(1);
  }
  const bananaBefore = await bananaAction.boundingBox();
  await bananaToggle.focus();
  await page.keyboard.press("Enter");
  await expect(bananaToggle).toHaveAttribute("aria-expanded", "true");
  await expect(bananaToggle).toBeFocused();
  await unchanged("first row expands", bananaAction, bananaBefore);
  const kiwiBefore = await kiwiAction.boundingBox();
  await kiwiToggle.click();
  await expect(kiwiToggle).toHaveAttribute("aria-expanded", "true");
  await expect(bananaToggle).toHaveAttribute("aria-expanded", "true");
  await unchanged("second row expands with first still open", kiwiAction, kiwiBefore);
  expect(await kiwiAction.evaluate((node, original) => node === original, actionNode)).toBe(true);
  const scroller = page.locator(".workspaceSettingsFeature > div");
  expect(await scroller.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  expect(await scroller.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  await expect(page.getByText("在此工作区启用", { exact: true })).toHaveCount(0);
  await expect(page.locator(".pluginSettingsBack, .pluginSettingsDetailHeader")).toHaveCount(0);
  await expect(page.locator(".pluginSettingsRow > .pluginEnableButton")).toHaveCount(2);
  const controls = await kiwiToggle.getAttribute("aria-controls");
  await expect(page.locator(`[id="${controls}"]`)).toBeVisible();
  await kiwiAction.click();
  await expect(kiwiAction).toHaveText("正在保存…");
  await unchanged("saving label", kiwiAction, kiwiBefore);
  finishEnablement();
  await expect(kiwiAction).toHaveText("已启用");
  await unchanged("enabled label", kiwiAction, kiwiBefore);
  await expect(kiwiToggle).toHaveAttribute("aria-expanded", "true");
  await page.getByLabel("kiwi-token Bearer Token").fill("synthetic-unsaved-draft");
  await expect(kiwiToggle).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("heading", { name: "工作空间插件", exact: true }).click();
  await expect(bananaToggle).toHaveAttribute("aria-expanded", "false");
  await expect(kiwiToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("dialog", { name: "工作空间插件" })).toBeVisible();
  await kiwiToggle.focus();
  await page.keyboard.press("Space");
  await expect(page.getByLabel("kiwi-token Bearer Token")).toHaveValue("synthetic-unsaved-draft");
  await expect(kiwiAction).toHaveAttribute("aria-pressed", "true");
  await kiwiToggle.click();
  await expect(kiwiToggle).toHaveAttribute("aria-expanded", "false");
  await kiwiToggle.click();
  await page.locator(".workspaceSettingsContent").click({ position: { x: 8, y: 120 } });
  await expect(kiwiToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("dialog", { name: "工作空间插件" })).toBeVisible();
  await testInfo.attach("button-layout", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
  console.log(`Plugin layout ${width}px: max delta ${Math.max(...measurements.flatMap((item) => Object.values(item.delta)))}px`);
});
}

for (const failedPart of ["mcpServers", "hooks", "credentials"]) {
  test(`Plugin management isolates ${failedPart} failure and keeps recovery available`, async ({ page }) => {
    let kiwiEnabled = true;
    let credential = failedPart === "mcpServers" ? null : { id: "kiwi-credential", pluginName: "kiwi", credentialRef: "kiwi-token", displayName: "Kiwi token", version: 1 };
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const base = (name) => ({
      name, displayName: name === "banana" ? "Banana" : "Kiwi", shortDescription: "Synthetic plugin",
      capabilities: [], version: "1.0.0", packageDigest: `sha256:${"a".repeat(64)}`,
      enabled: name === "kiwi" && kiwiEnabled, skills: [], cli: [],
      mcpServers: null, hooks: null, errors: [],
      mcpCredentialRefs: name === "kiwi" ? ["kiwi-token"] : [],
    });
    let finishInspection;
    const inspectionReady = new Promise((resolve) => { finishInspection = resolve; });
    await page.route("http://localhost:8000/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/me") return route.fulfill({ json: { user: { id: "1", email: "admin@example.com", isSuperuser: true } } });
      if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "Isolation", role: "owner" }] } });
      if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [] } });
      if (path === "/api/workspaces/ws_1/sessions") return route.fulfill({ json: { sessions: [] } });
      if (path === "/api/models") return route.fulfill({ json: { models: [] } });
      if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "synthetic-csrf" } });
      if (path === "/api/workspaces/ws_1/plugins") return route.fulfill({ json: { plugins: [base("banana"), base("kiwi")] } });
      if (path === "/api/workspaces/ws_1/plugins/banana") return route.fulfill({ json: { plugin: { ...base("banana"), mcpServers: [], hooks: [], enabled: request.method() === "PATCH" } } });
      if (path === "/api/workspaces/ws_1/plugins/kiwi") {
        if (request.method() === "PATCH") {
          expect(request.postDataJSON()).toEqual({ enabled: false });
          kiwiEnabled = false;
          return route.fulfill({ json: { plugin: base("kiwi") } });
        }
        const detail = { ...base("kiwi"), mcpServers: [], hooks: [] };
        await inspectionReady;
        detail[failedPart === "hooks" ? "hooks" : "mcpServers"] = null;
        detail.errors = [failedPart === "hooks" ? "workspace_hook_catalog_unavailable" : "workspace_mcp_catalog_unavailable"];
        return route.fulfill({ json: { plugin: detail } });
      }
      if (path === "/api/admin/mcp-bearer-credentials") {
        if (failedPart === "credentials") return route.fulfill({ status: 503, json: { error: "credential_store_unavailable" } });
        if (request.method() === "POST") {
          const body = request.postDataJSON();
          expect(body.pluginName).toBe("kiwi");
          expect(body.credentialRef).toBe("kiwi-token");
          expect(body.secret).toBe("Bearer synthetic-created-token");
          credential = { id: "kiwi-credential", pluginName: "kiwi", credentialRef: body.credentialRef, displayName: body.displayName, version: 1 };
          return route.fulfill({ status: 201, json: { credential } });
        }
        return route.fulfill({ json: { credentials: credential ? [credential] : [] } });
      }
      if (path === "/api/admin/mcp-bearer-credentials/kiwi-credential/rotate") {
        credential = { ...credential, version: 2 };
        return route.fulfill({ json: { credential } });
      }
      return route.fulfill({ status: 404, json: { error: "not_found" } });
    });
    await page.goto("/w/ws_1/settings/plugins");
    await expect(page.getByRole("button", { name: "启用 Banana", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "停用 Kiwi", exact: true }).click();
    await expect(page.getByRole("button", { name: "启用 Kiwi", exact: true })).toBeDisabled();
    finishInspection();
    await expect(page.getByRole("status")).toContainText(failedPart === "hooks" ? "Hooks 无法校验" : "MCP 声明无法校验");
    // An older inspection must not resurrect enablement after a successful disable.
    await expect(page.getByRole("button", { name: "启用 Kiwi", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "启用 Banana", exact: true }).click();
    await expect(page.getByRole("button", { name: "停用 Banana", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "查看 Kiwi 详细信息" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "不影响其他插件" })).toBeVisible();
    await expect(page.locator(".pluginCredentialForm input")).toHaveCount(1);
    await expect(page.getByLabel("新凭据引用", { exact: true })).toHaveCount(0);
    if (failedPart === "credentials") {
      await expect(page.getByRole("alert").filter({ hasText: "凭据操作失败" })).toBeVisible();
      await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    } else {
      if (failedPart === "mcpServers") {
        await page.getByLabel("kiwi-token Bearer Token", { exact: true }).fill("Bearer synthetic-created-token");
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await expect(page.getByText("已配置 · v1", { exact: true })).toBeVisible();
      }
      await page.getByLabel("kiwi-token Bearer Token", { exact: true }).fill("synthetic-rotated-token");
      await page.getByRole("button", { name: "轮换", exact: true }).click();
      await expect(page.getByText("已配置 · v2", { exact: true })).toBeVisible();
      await expect(page.locator(".pluginCredentialForm input")).toHaveCount(1);
    }
    expect(pageErrors).toEqual([]);
  });
}

test("superuser uploads and removes globally installed Plugins", async ({ page }) => {
  let bananaInstalled = true;
  let uploadRequest = null;
  const globalPlugins = () => [{
    name: "office",
    displayName: "Office Extension",
    shortDescription: "Synthetic extension fixture.",
    capabilities: ["Word", "Excel", "PowerPoint", "PDF"],
    version: "1.0.0",
    enabledWorkspaceCount: 1,
    credentialCount: 0,
    removable: false,
    errors: [],
  }, {
    name: "banana",
    displayName: "Banana Extension",
    shortDescription: "Synthetic extension fixture.",
    capabilities: ["Synthetic capability", "Fixture validation"],
    version: "1.0.0",
    enabledWorkspaceCount: 0,
    credentialCount: 0,
    removable: true,
    errors: [],
  }].filter((plugin) => plugin.name !== "banana" || bananaInstalled);
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "1", email: "admin@example.com", isStaff: true, isSuperuser: true } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "默认工作区", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [] } });
    if (path === "/api/workspaces/ws_1/session-projects") return route.fulfill({ json: { projects: [] } });
    if (path === "/api/workspaces/ws_1/session-projects") return route.fulfill({ json: { projects: [] } });
    if (path === "/api/workspaces/ws_1/session-projects") return route.fulfill({ json: { projects: [] } });
    if (path === "/api/workspaces/ws_1/sessions") return route.fulfill({ json: { sessions: [] } });
    if (path === "/api/models") return route.fulfill({ json: { models: [] } });
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "csrf-test-token" } });
    if (path === "/api/admin/plugins" && request.method() === "GET") return route.fulfill({ json: { plugins: globalPlugins() } });
    if (path === "/api/admin/plugins/upload" && request.method() === "POST") {
      uploadRequest = {
        contentType: request.headers()["content-type"],
        body: request.postDataBuffer(),
      };
      return route.fulfill({ json: { plugin: {
        name: "orange",
        displayName: "Orange Extension",
        shortDescription: "Uploaded extension fixture.",
        capabilities: [],
        version: "1.0.0",
        enabledWorkspaceCount: 0,
        credentialCount: 0,
        removable: true,
        errors: [],
      } } });
    }
    if (path === "/api/admin/plugins/banana" && request.method() === "DELETE") {
      bananaInstalled = false;
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/settings/global-plugins");
  const settingsDialog = page.getByRole("dialog", { name: "平台插件" });
  await expect(settingsDialog).toBeVisible();
  await expect(settingsDialog.getByRole("link", { name: "模型", exact: true }).locator("svg")).toHaveClass(/lucide-cpu/);
  await expect(settingsDialog.getByRole("link", { name: "平台插件", exact: true }).locator("svg")).toHaveClass(/lucide-boxes/);
  await expect(page.getByLabel("插件生命周期层级")).toHaveCount(0);
  await expect(page.locator(".workspaceSettingsFeature > header > p")).toHaveCount(0);
  await expect(page.getByText("已安装", { exact: true })).toHaveCount(2);
  await expect(page.getByText("1 个工作区已启用", { exact: true })).toBeVisible();
  await expect(page.getByText("1 个工作区仍在使用", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "移除 Office Extension" })).toBeDisabled();
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传 ZIP", exact: true }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({ name: "orange.zip", mimeType: "application/zip", buffer: Buffer.from("PK synthetic plugin") });
  await expect(page.getByText("Orange Extension 已安装。", { exact: true })).toBeVisible();
  await expect(page.getByText("Orange Extension", { exact: true })).toBeVisible();
  expect(uploadRequest.contentType).toContain("multipart/form-data");
  expect(uploadRequest.body.toString()).toContain('name="file"; filename="orange.zip"');
  const pluginRows = page.locator(".globalPluginEntry");
  const primaryDescriptionBox = await pluginRows.nth(0).locator(":scope > p").boundingBox();
  const secondaryDescriptionBox = await pluginRows.nth(1).locator(":scope > p").boundingBox();
  const primaryFactsBox = await pluginRows.nth(0).locator(".globalPluginFacts").boundingBox();
  const secondaryFactsBox = await pluginRows.nth(1).locator(".globalPluginFacts").boundingBox();
  expect(primaryDescriptionBox.x).toBe(secondaryDescriptionBox.x);
  expect(primaryFactsBox.x).toBe(secondaryFactsBox.x);
  await expect(pluginRows.nth(1).locator(".globalPluginActions")).toHaveCSS("justify-content", "center");
  const secondaryActionsBox = await pluginRows.nth(1).locator(".globalPluginActions").boundingBox();
  const removeButtonBox = await page.getByRole("button", { name: "移除 Banana Extension" }).boundingBox();
  expect(Math.abs((secondaryActionsBox.x + secondaryActionsBox.width / 2) - (removeButtonBox.x + removeButtonBox.width / 2))).toBeLessThan(1);
  await page.getByRole("button", { name: "移除 Banana Extension" }).click();
  const dialog = page.getByRole("dialog", { name: "移除全局插件？" });
  await dialog.getByRole("button", { name: "移除" }).click();
  await expect(page.getByText("Banana Extension", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Banana Extension 已移除。", { exact: true })).toBeVisible();
});
