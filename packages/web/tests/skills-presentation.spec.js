const { test, expect } = require("@playwright/test");
const { readdir, stat } = require("node:fs/promises");
const path = require("node:path");

const createSkill = (skillId, name) => ({
  skillId,
  name,
  description: `${name} investigation fixture.`,
  enabled: true,
  allowImplicitInvocation: false,
  allowedTools: [],
});

async function installSkillFixture(page, skills, contentBySkillId) {
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const requestPath = url.pathname;
    if (requestPath === "/api/csrf") {
      return route.fulfill({ json: { csrfToken: "test-token" } });
    }
    if (requestPath === "/api/me") {
      return route.fulfill({
        json: {
          user: {
            id: "user_1",
            email: "member@example.com",
            isStaff: false,
            isSuperuser: false,
          },
        },
      });
    }
    if (requestPath === "/api/workspaces") {
      return route.fulfill({
        json: {
          workspaces: [{ id: "ws_1", name: "默认工作区", role: "owner" }],
        },
      });
    }
    if (requestPath === "/api/workspaces/ws_1/agents") {
      return route.fulfill({ json: { agents: [] } });
    }
    if (requestPath === "/api/workspaces/ws_1/sessions") {
      return route.fulfill({ json: { sessions: [] } });
    }
    if (requestPath === "/api/models") {
      return route.fulfill({ json: { models: [] } });
    }
    if (requestPath === "/api/workspaces/ws_1/skills") {
      return route.fulfill({
        json: { schema: "workspace.skill.catalog.result.v1", skills },
      });
    }
    const detailPrefix = "/api/workspaces/ws_1/skills/";
    if (requestPath.startsWith(detailPrefix)) {
      const skillId = decodeURIComponent(requestPath.slice(detailPrefix.length));
      const skill = skills.find((item) => item.skillId === skillId);
      const content = contentBySkillId[skillId];
      if (!skill || content === undefined) {
        return route.fulfill({ status: 404, json: { error: "not_found" } });
      }
      return route.fulfill({
        json: {
          schema: "workspace.skill.detail.result.v1",
          skill,
          content,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });
}

async function openSkillPreview(page, name) {
  await page.getByRole("row", { name: `预览 ${name}`, exact: true }).click();
  const preview = page.getByRole("complementary", { name: "Skill 预览" });
  await expect(preview).toBeVisible();
  return preview;
}

test("Skill previews preserve the canonical Markdown link and table semantics", async ({ page }) => {
  const skill = createSkill("plugin-docs-0:docs", "docs");
  await installSkillFixture(page, [skill], {
    [skill.skillId]: [
      "# Documentation",
      "",
      "[Safe reference](https://example.com/reference)",
      "",
      "[Unsafe reference](javascript:alert(1))",
      "",
      "| Field | Value |",
      "| --- | --- |",
      "| mode | strict |",
    ].join("\n"),
  });

  await page.goto("/w/ws_1/library?view=skills");
  const preview = await openSkillPreview(page, skill.name);

  await expect.soft(preview.getByRole("link", { name: "Safe reference" })).toHaveAttribute(
    "href",
    "https://example.com/reference",
  );
  await expect.soft(preview.getByRole("link", { name: "Unsafe reference" })).toHaveCount(0);
  await expect.soft(preview.getByRole("table")).toContainText("mode");
  await expect.soft(preview.getByRole("table")).toContainText("strict");
});

test("a Chinese workspace page downloads only the Noto glyph shards it uses", async ({ page }) => {
  const skill = createSkill("system:memory", "记忆");
  await installSkillFixture(page, [skill], {
    [skill.skillId]: "# 记忆\n\n只读取与当前任务有关的内容。",
  });
  const fontResponses = [];
  page.on("response", (response) => {
    if (response.url().includes("NotoSansCJKsc") && response.url().includes(".woff2")) {
      fontResponses.push(response);
    }
  });

  await page.goto("/w/ws_1/library?view=skills");
  await expect(page.getByRole("table", { name: "Skills" })).toContainText("记忆");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const downloaded = await Promise.all(
    fontResponses.map(async (response) => ({
      filename: path.basename(new URL(response.url()).pathname),
      sizeBytes: (await response.body()).byteLength,
    })),
  );

  const fontDirectory = path.resolve(__dirname, "../src/assets/fonts");
  const notoFiles = (await readdir(fontDirectory)).filter(
    (filename) => filename.startsWith("NotoSansCJKsc") && filename.endsWith(".woff2"),
  );
  const repositoryBytes = (
    await Promise.all(notoFiles.map(async (filename) => (await stat(path.join(fontDirectory, filename))).size))
  ).reduce((total, sizeBytes) => total + sizeBytes, 0);
  const downloadedBytes = downloaded.reduce(
    (total, font) => total + font.sizeBytes,
    0,
  );

  expect(downloaded.length).toBeGreaterThan(0);
  expect(downloaded.length).toBeLessThan(notoFiles.length);
  expect(downloaded.every((font) => !font.filename.includes("hangul"))).toBe(true);
  expect(downloadedBytes).toBeLessThan(repositoryBytes);
  expect(downloadedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  test.info().annotations.push({
    type: "font-transfer",
    description: `${downloaded.length}/${notoFiles.length} shards, ${downloadedBytes}/${repositoryBytes} bytes`,
  });
});
