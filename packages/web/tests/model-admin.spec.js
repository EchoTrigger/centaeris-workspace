const { test, expect } = require("@playwright/test");

function template(id, displayName, models) {
  return {
    id,
    displayName,
    api: "openai-completions",
    apiBase: id === "moonshot_cn" ? "https://api.moonshot.cn/v1" : "https://api.deepseek.com",
    models,
  };
}

function adminModel(id, providerId, modelName, displayName = "") {
  return {
    id,
    providerId,
    providerDisplayName: providerId === "provider_moonshot_cn" ? "Moonshot AI CN" : "new-provider",
    displayName,
    modelName,
    api: "openai-completions",
    apiOverride: null,
    apiBase: "https://api.example.com/v1",
    contextTokens: 128000,
    maxOutputTokens: 16384,
    thinkingMode: null,
    thinkingModes: [],
    enabled: true,
    revision: 1,
    updatedAt: "2026-08-01T00:00:00Z",
  };
}

async function mockAdminApi(page) {
  const state = {
    providers: [],
    models: [],
    creates: [],
    tests: [],
    reads: { providers: 0, models: 0, templates: 0 },
    templates: [
      template("deepseek", "DeepSeek", [{ modelName: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", contextTokens: 1000000, maxOutputTokens: 384000, thinkingMode: "high", thinkingModes: ["high", "max"] }]),
      template("moonshot_cn", "Moonshot AI CN", [
        { modelName: "kimi-k3", displayName: "Kimi K3", contextTokens: 1048576, maxOutputTokens: 131072 },
        { modelName: "kimi-k2.7-code", displayName: "Kimi K2.7 Code", contextTokens: 262144, maxOutputTokens: 131072 },
      ]),
    ],
  };
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "1", email: "admin@example.com", isStaff: true, isSuperuser: true } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "Default", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [] } });
    if (path === "/api/workspaces/ws_1/session-projects") return route.fulfill({ json: { projects: [] } });
    if (path === "/api/workspaces/ws_1/sessions") return route.fulfill({ json: { sessions: [] } });
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "csrf-test-token" } });
    if (path === "/api/models") return route.fulfill({ json: { models: state.models.filter((model) => model.enabled).map(({ api, apiOverride, apiBase, enabled, revision, updatedAt, ...model }) => model) } });
    if (path === "/api/admin/model-providers" && request.method() === "GET") {
      state.reads.providers += 1;
      return route.fulfill({ json: { providers: state.providers } });
    }
    if (path === "/api/admin/models" && request.method() === "GET") {
      state.reads.models += 1;
      return route.fulfill({ json: { models: state.models } });
    }
    if (path === "/api/admin/model-provider-templates") {
      state.reads.templates += 1;
      return route.fulfill({ json: { templates: state.templates } });
    }
    if (path === "/api/admin/model-provider-templates/moonshot_cn/instantiate") {
      state.creates.push(request.postDataJSON());
      const provider = { id: "provider_moonshot_cn", displayName: "Moonshot AI CN", templateId: "moonshot_cn", api: "openai-completions", apiBase: "https://api.moonshot.cn/v1", enabled: true, credentialVersion: 1, updatedAt: "2026-08-01T00:00:00Z" };
      state.providers = [provider];
      state.models = state.templates[1].models.map((item, index) => ({ ...adminModel(`model_moonshot_${index}`, provider.id, item.modelName, item.displayName), providerDisplayName: "Moonshot AI CN", contextTokens: item.contextTokens, maxOutputTokens: item.maxOutputTokens }));
      return route.fulfill({ status: 201, json: { provider } });
    }
    if (path === "/api/admin/model-providers" && request.method() === "POST") {
      const body = request.postDataJSON();
      state.creates.push(body);
      const provider = { id: "provider_custom", displayName: body.displayName, templateId: null, api: body.api, apiBase: body.apiBase, enabled: true, credentialVersion: 1, updatedAt: "2026-08-01T00:00:00Z" };
      state.providers.push(provider);
      return route.fulfill({ status: 201, json: { provider } });
    }
    if (path.startsWith("/api/admin/model-providers/") && path.endsWith("/credential/rotate")) {
      const providerId = path.split("/")[4];
      const provider = state.providers.find((item) => item.id === providerId);
      state.creates.push(request.postDataJSON());
      return route.fulfill({ json: { provider: { ...provider, credentialVersion: provider.credentialVersion + 1 } } });
    }
    if (path.startsWith("/api/admin/model-providers/") && request.method() === "PATCH") {
      const providerId = path.split("/")[4];
      const provider = state.providers.find((item) => item.id === providerId);
      Object.assign(provider, request.postDataJSON());
      return route.fulfill({ json: { provider } });
    }
    if (path.startsWith("/api/admin/model-providers/") && request.method() === "DELETE") {
      const providerId = path.split("/")[4];
      state.providers = state.providers.filter((item) => item.id !== providerId);
      state.models = state.models.filter((item) => item.providerId !== providerId);
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/admin/models" && request.method() === "POST") {
      const body = request.postDataJSON();
      state.creates.push(body);
      const model = { ...adminModel("model_custom", body.providerId, body.modelName, body.displayName), ...body };
      state.models.push(model);
      return route.fulfill({ status: 201, json: { model } });
    }
    if (path.startsWith("/api/admin/models/") && path.endsWith("/test")) {
      state.tests.push(path);
      return route.fulfill({ json: { ok: false, httpStatus: 401, latencyMs: 16, outputPreview: null, errorKeyword: "provider_authentication_failed" } });
    }
    if (path.startsWith("/api/admin/models/") && request.method() === "DELETE") {
      const modelId = path.split("/")[4];
      state.models = state.models.filter((item) => item.id !== modelId);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  return state;
}

test("superuser connects a managed provider without exposing model editing", async ({ page }) => {
  const state = await mockAdminApi(page);
  await page.goto("/w/ws_1/settings/models");
  await expect(page.getByRole("dialog", { name: "模型" })).toBeVisible();
  await expect(page.locator(".workspaceSettingsFeature > header > p")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "模型", exact: true }).locator("svg.lucide-cpu")).toBeVisible();
  await expect(page.getByText("No providers", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add provider", exact: true }).last().click();
  await expect(page.getByRole("dialog", { name: "Add provider" })).toHaveCount(0);
  const picker = page.getByRole("region", { name: "Add provider" });
  await expect(page.getByPlaceholder("Search providers…")).toHaveCount(0);
  await expect(picker.getByText("CUSTOM", { exact: true })).toBeVisible();
  await expect(picker.getByText("API KEY", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "模型" })).toBeVisible();
  expect(state.reads).toEqual({ providers: 1, models: 1, templates: 1 });
  await page.getByRole("button", { name: "Add provider", exact: true }).last().click();
  await picker.getByRole("button", { name: /^Moonshot AI CN/ }).click();
  await expect(page.locator(".workspaceModelsTreeModels")).toHaveCount(0);
  await expect(page.locator(".workspaceModelsPreset > p")).toHaveCount(0);
  const keyInput = page.getByLabel("API Key", { exact: true });
  await expect(page.locator(".workspaceModelsPreset label")).toHaveCount(0);
  await keyInput.focus();
  await expect(keyInput).toHaveCSS("border-top-width", "0px");
  await expect(keyInput).toHaveCSS("box-shadow", "none");
  await expect(page.locator(".workspaceModelsKeyInput")).toHaveCSS("border-top-color", "rgb(105, 154, 241)");
  await keyInput.fill("test-provider-secret");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(page.locator(".workspaceModelsProviderGroup").getByText("Moonshot AI CN", { exact: true })).toBeVisible();
  await expect(page.getByText("已配置", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "断开连接", exact: true })).toBeVisible();
  await expect(page.locator(".workspaceModelsTreeModels")).toHaveCount(0);
  expect(state.creates).toContainEqual({ secret: "test-provider-secret" });
  expect(await page.locator("body").innerText()).not.toContain("test-provider-secret");
  expect(state.providers[0].templateId).toBe("moonshot_cn");
  expect(state.models.map((model) => model.modelName)).toEqual(["kimi-k3", "kimi-k2.7-code"]);
  await page.getByRole("button", { name: "断开连接", exact: true }).click();
  const disconnectDialog = page.getByRole("dialog", { name: "断开供应商？" });
  await expect(disconnectDialog).toContainText("“Moonshot AI CN”及其模型将不再可用。");
  await disconnectDialog.getByRole("button", { name: "取消", exact: true }).click();
  expect(state.providers).toHaveLength(1);
  expect(state.models).toHaveLength(2);
});

test("custom provider renames explicitly and model ID updates the tree before save", async ({ page }) => {
  const state = await mockAdminApi(page);
  await page.goto("/w/ws_1/settings/models");
  await page.getByRole("button", { name: "Add provider", exact: true }).last().click();
  await page.getByRole("region", { name: "Add provider" }).getByRole("button", { name: /^Custom/ }).click();
  await page.getByLabel("供应商名称", { exact: true }).fill("vLLM");
  await expect(page.locator(".workspaceModelsSidebar")).toContainText("new-provider");
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  await expect(page.locator(".workspaceModelsSidebar")).toContainText("vLLM");
  await page.getByLabel("Base URL", { exact: true }).fill("https://models.example.com/v1");
  await page.getByLabel("API Key", { exact: true }).fill("1");
  await expect(page.getByRole("checkbox", { name: "Allow HTTP endpoints (for vLLM)" })).toHaveCount(0);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(state.creates).toContainEqual({ displayName: "vLLM", api: "openai-completions", apiBase: "https://models.example.com/v1", secret: "1" });

  await page.getByRole("button", { name: "model", exact: true }).click();
  await page.getByLabel("ID *", { exact: true }).fill("qwen3.6-27b");
  await page.getByLabel("Supported efforts", { exact: true }).fill("low, vendor-high");
  await page.getByLabel("Default thinking effort", { exact: true }).fill("vendor-high");
  await expect(page.locator(".workspaceModelsSidebar")).toContainText("qwen3.6-27b");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(state.creates).toContainEqual(expect.objectContaining({ providerId: "provider_custom", modelName: "qwen3.6-27b", displayName: "", thinkingMode: "vendor-high", thinkingModes: ["low", "vendor-high"] }));
});

test("saved provider rename persists immediately via PATCH", async ({ page }) => {
  const state = await mockAdminApi(page);
  state.providers.push({ id: "provider_custom", displayName: "vLLM", templateId: null, api: "openai-completions", apiBase: "https://models.example.com/v1", enabled: true, credentialVersion: 1, updatedAt: "2026-08-01T00:00:00Z" });
  await page.goto("/w/ws_1/settings/models");
  await page.getByRole("button", { name: /^vLLM/ }).click();
  await page.getByLabel("供应商名称", { exact: true }).fill("Qwen vLLM");
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(state.providers[0]).toMatchObject({ displayName: "Qwen vLLM" });
  await expect(page.locator(".workspaceModelsSidebar")).toContainText("Qwen vLLM");
});

test("refreshes the retained chat model picker and ignores superseded model responses", async ({ page }) => {
  const state = await mockAdminApi(page);
  state.providers = [
    { id: "provider_moonshot_cn", displayName: "Moonshot AI CN", templateId: "moonshot_cn", api: "openai-completions", apiBase: "https://api.moonshot.cn/v1", enabled: true, credentialVersion: 1, updatedAt: "2026-08-01T00:00:00Z" },
    { id: "provider_deepseek", displayName: "DeepSeek", templateId: "deepseek", api: "openai-completions", apiBase: "https://api.deepseek.com", enabled: true, credentialVersion: 1, updatedAt: "2026-08-01T00:00:00Z" },
  ];
  state.models = [adminModel("model_1", "provider_moonshot_cn", "kimi-k3", "Kimi K3"), adminModel("model_2", "provider_deepseek", "deepseek-v4-pro", "DeepSeek V4 Pro")];
  let catalogReads = 0;
  let releaseStale;
  let staleDelivered;
  const staleGate = new Promise((resolve) => { releaseStale = resolve; });
  const staleDelivery = new Promise((resolve) => { staleDelivered = resolve; });
  await page.route("http://localhost:8000/api/models", async (route) => {
    const read = ++catalogReads;
    const models = structuredClone(state.models);
    if (read === 2) await staleGate;
    await route.fulfill({ json: { models } });
    if (read === 2) staleDelivered();
  });
  await page.route("http://localhost:8000/api/workspaces/ws_1/agents", (route) => route.fulfill({ json: { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "", avatarKind: "centaeris", status: "active", deletedAt: null }] } }));
  await page.goto("/w/ws_1/app");
  const composer = page.locator("#messageDraft");
  await composer.fill("Model settings draft");
  await composer.evaluate((element) => { window.__modelSettingsComposer = element; });
  await expect(page.getByRole("button", { name: "AI 模型", exact: true })).toContainText("Kimi K3");
  await page.getByRole("button", { name: "Default 工作区菜单" }).click();
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("dialog", { name: "偏好", exact: true }).getByRole("link", { name: "模型", exact: true }).click();
  await page.getByRole("button", { name: "断开连接", exact: true }).click();
  await page.getByRole("dialog", { name: "断开供应商？" }).getByRole("button", { name: "断开连接", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "断开供应商？" })).toHaveCount(0);
  await expect.poll(() => catalogReads).toBe(2);
  await page.getByRole("complementary", { name: "Model providers" }).getByRole("button", { name: /^DeepSeek/ }).click();
  await page.getByRole("button", { name: "断开连接", exact: true }).click();
  await page.getByRole("dialog", { name: "断开供应商？" }).getByRole("button", { name: "断开连接", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "断开供应商？" })).toHaveCount(0);
  await expect.poll(() => catalogReads).toBe(3);
  await page.getByRole("dialog", { name: "模型", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("button", { name: "AI 模型", exact: true })).toHaveText("未配置");
  releaseStale();
  await staleDelivery;
  await page.waitForTimeout(100);
  await expect(page.getByRole("button", { name: "AI 模型", exact: true })).toHaveText("未配置");
  await expect(composer).toHaveValue("Model settings draft");
  expect(await composer.evaluate((element) => element === window.__modelSettingsComposer)).toBe(true);
});

test("members are redirected away from the provider control plane", async ({ page }) => {
  await page.route("http://localhost:8000/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "2", email: "member@example.com", isStaff: false, isSuperuser: false } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "Default", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [] } });
    if (path === "/api/models") return route.fulfill({ json: { models: [] } });
    if (path === "/api/workspaces/ws_1/session-projects") return route.fulfill({ json: { projects: [] } });
    if (path === "/api/workspaces/ws_1/sessions") return route.fulfill({ json: { sessions: [] } });
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.goto("/w/ws_1/settings/models");
  await expect(page).toHaveURL(/\/w\/ws_1\/settings\/general$/);
  await expect(page.getByRole("dialog", { name: "模型" })).toHaveCount(0);
  await expect(page.getByText("暂未开放", { exact: true })).toBeVisible();
  await expect(page.locator(".workspaceSettingsPlaceholder p")).toHaveCount(0);
});
