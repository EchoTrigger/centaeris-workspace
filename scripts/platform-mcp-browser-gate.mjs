// Real API + real web UI against the isolated live-model run. No model calls.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

const runId = process.argv[2];
assert.match(runId || "", /^agent_run_[a-zA-Z0-9_-]+$/);
const container = "centaeris-platform-mcp-e2e-api-1";
const metadata = JSON.parse(execFileSync("docker", ["inspect", container], { encoding: "utf8" }))[0];
assert.equal(metadata.Config.Labels["com.docker.compose.project"], "centaeris-platform-mcp-e2e");
// Session cookie stays in process memory; never print it or put it in arguments.
const code = `import os,json; os.environ.setdefault('DJANGO_SETTINGS_MODULE','api.settings'); import django; django.setup(); from django.test import Client; from app_core.models import AgentRun,SessionCitationProjection; r=AgentRun.objects.get(pk=${JSON.stringify(runId)}); c=Client(HTTP_HOST='localhost'); c.force_login(r.user); x=SessionCitationProjection.objects.get(agent_run=r); print(json.dumps({'cookie':c.cookies['sessionid'].value,'workspaceId':r.workspace_id,'sessionId':r.session_id,'agentId':r.session.agent_id,'citationId':x.citationId,'displayName':x.displayName}))`;
const fixture = JSON.parse(execFileSync("docker", ["exec", container, "python", "-c", code], { encoding: "utf8" }));
const port = execFileSync("docker", ["port", container, "8000"], { encoding: "utf8" }).trim();
assert.match(port, /^127\.0\.0\.1:\d+$/);
const apiUrl = `http://${port}`;
const webUrl = "http://127.0.0.1:43108";
const root = fileURLToPath(new URL("../", import.meta.url));
const server = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)),
  "--host", "127.0.0.1", "--port", "43108", "--strictPort"],
{ cwd: `${root}/packages/web`, env: { ...process.env, API_BASE_URL: apiUrl }, stdio: "ignore", windowsHide: true });
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    assert.equal(server.exitCode, null, "owned Vite server exited");
    try { ready = (await fetch(webUrl)).ok; } catch { /* startup */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, "owned Vite startup timeout");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies([{ name: "sessionid", value: fixture.cookie, url: apiUrl, httpOnly: true, secure: false }]);
  const page = await context.newPage();
  await page.goto(`${webUrl}/w/${fixture.workspaceId}/agents/${fixture.agentId}?sessionId=${fixture.sessionId}`);
  const button = page.getByRole("button", { name: `${fixture.displayName} 引用`, exact: true });
  await button.click({ timeout: 15000 });
  const preview = page.getByRole("complementary", { name: "文件预览", exact: true });
  await preview.waitFor({ state: "visible", timeout: 15000 });
  await expect(preview).toContainText(/The acceptance code is [0-9a-f]{32}/);
  await page.reload();
  await button.click({ timeout: 15000 });
  await preview.waitFor({ state: "visible", timeout: 15000 });
  await expect(preview).toContainText(/The acceptance code is [0-9a-f]{32}/);
  console.log("Real Workspace browser citation: history, click, processed preview and reload passed");
} finally {
  if (browser) await browser.close();
  server.kill();
}
