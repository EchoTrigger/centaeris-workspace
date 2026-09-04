const { test, expect } = require("@playwright/test");

function historyPage(session, agentRuns, { nextCursor = null, hasMore = false } = {}) {
  return {
    schema: "session.history.page.v1",
    session,
    agentRuns: agentRuns.map((agentRun) => {
      const finalAssistantIndex = ["completed", "failed"].includes(agentRun.status)
        ? agentRun.messages.findLastIndex((message) => message.role === "assistant")
        : -1;
      let sequence = 0;
      const events = [];
      const append = (type, payload, turnId = agentRun.turnId) => {
        sequence += 1;
        const event = sessionEvent(session.id, agentRun.id, sequence, type, payload, turnId);
        const startedAtMs = Date.parse(agentRun.startedAt || agentRun.createdAt || "");
        if (Number.isFinite(startedAtMs)) event.createdAtMs = startedAtMs + sequence - 1;
        if (["agent_run_completed", "agent_run_failed", "agent_run_interrupted"].includes(type) && agentRun.completedAt) {
          event.createdAtMs = Date.parse(agentRun.completedAt);
        }
        events.push({ sequence, event });
      };
      append("agent_run_started", { userObjective: agentRun.messages.find((message) => message.role === "user")?.text || "fixture" });
      agentRun.messages.forEach((message, index) => {
        const turnId = message.turnId || agentRun.turnId;
        if (message.role === "user") append("user_message", { messageId: message.messageId, text: message.text, attachments: message.attachments || [] }, turnId);
        else if (index !== finalAssistantIndex) append("phase_event", { stage: "model_process_summary", message: message.text }, turnId);
      });
      for (const record of agentRun.records || []) append(record.type, record.payload, record.turnId || agentRun.turnId);
      const finalMessage = finalAssistantIndex >= 0 ? agentRun.messages[finalAssistantIndex] : null;
      const artifacts = agentRun.artifacts || [];
      for (const artifact of artifacts) append("artifact_published", artifact, artifact.turnId || agentRun.turnId);
      if (finalMessage) append("assistant_message", {
        messageId: finalMessage.messageId,
        modelMarkdown: finalMessage.text,
        artifactRefs: artifacts.map((artifact) => artifact.artifactRef),
        status: agentRun.status === "failed" ? "error" : "done",
      }, finalMessage.turnId || agentRun.turnId);
      if (agentRun.status === "completed") append("agent_run_completed", { doneReason: "finalized" });
      else if (agentRun.status === "failed") append("agent_run_failed", { reasonType: "runtime_error", message: "fixture failed" });
      else if (agentRun.status === "cancelled") append("agent_run_interrupted", { reasonType: "cancelled", message: "fixture cancelled", retryable: false });
      return {
        id: agentRun.id,
        status: agentRun.status,
        model: agentRun.model,
        createdAt: agentRun.createdAt,
        startedAt: agentRun.startedAt,
        completedAt: agentRun.completedAt,
        events,
        live: agentRun.live ? { messageId: agentRun.live.messageId, turnId: agentRun.live.turnId || agentRun.turnId, afterSequence: sequence, revision: agentRun.live.revision || 1, text: agentRun.live.text } : null,
        streamCursor: agentRun.streamCursor || "0-0",
      };
    }),
    nextCursor,
    hasMore,
  };
}

function sessionEvent(sessionId, agentRunId, sequence, type, payload, turnId) {
  return {
    schemaVersion: "session.event.v1",
    eventVersion: 1,
    sequence,
    type,
    eventId: `event:${agentRunId}:${sequence}`,
    sessionId: sessionId,
    turnId,
    agentRunId: agentRunId,
    createdAtMs: 1780000000000 + sequence,
    payload,
  };
}

function committedStreamItem(sessionId, agentRunId, sequence, type, payload, turnId) {
  return { schema: "session.stream.item.v1", kind: "committed", agentRunId, sourceSequence: sequence, event: sessionEvent(sessionId, agentRunId, sequence, type, payload, turnId) };
}

function liveStreamItem(agentRunId, revision, text, turnId) {
  return { schema: "session.stream.item.v1", kind: "live", agentRunId, afterSequence: 2, revision, turnId, messageId: `message:${turnId}:assistant`, text };
}

function sse(items) {
  return items.map((item, index) => `id: ${index + 1}-0\ndata: ${JSON.stringify(item)}\n\n`).join("");
}

function multipartField(body, name) {
  return body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1] || "";
}

test("running input queues without inventing a committed session message", async ({ page }) => {
  let supplementBody = null;
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const responses = {
      "/api/csrf": { csrfToken: "test-token" },
      "/api/me": { user: { id: "user_1", email: "member@example.com", isStaff: false } },
      "/api/workspaces": { workspaces: [{ id: "ws_1", name: "默认工作区", description: "", status: "active", role: "owner" }] },
      "/api/workspaces/ws_1/agents": { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", avatarKind: "centaeris", status: "active", deletedAt: null }] },
      "/api/models": { models: [{ id: "model_1", displayName: "Clinical", provider: "fake", modelName: "fake-model" }] },
      "/api/workspaces/ws_1/session-projects": { projects: [] },
      "/api/workspaces/ws_1/sessions": { sessions: [{ id: "sess_1", workspaceId: "ws_1", title: "Running", origin: "user", status: "active", isPinned: false, isUnread: false, hasActiveAgentRun: true, updatedAt: "2026-08-13T00:00:00Z" }] },
      "/api/sessions/sess_1/assets": { assets: [] },
      "/api/sessions/sess_1/context-usage": {
        schema: "session.context_usage.v1",
        sessionId: "sess_1",
        contextUsage: {
          usedTokens: 89268,
          maxContextTokens: 200000,
          usedPercentage: 45,
          updatedAt: 1780000000000,
          isCompacting: false,
          breakdown: {
            systemPromptTokens: 2600,
            systemToolTokens: 18900,
            mcpToolTokens: 5700,
            skillsTokens: 2000,
            messageTokens: 27300,
            autoCompactBufferTokens: 32768,
            freeSpaceTokens: 110732,
            mcpTools: [{ providerId: "mcp:banana:banana", name: "banana_search", tokens: 5700 }],
          },
        },
      },
      "/api/sessions/sess_1/history": historyPage(
        { id: "sess_1", workspaceId: "ws_1", title: "Running", origin: "user", status: "active", isPinned: false, isUnread: false, hasActiveAgentRun: true, updatedAt: "2026-08-13T00:00:00Z" },
        [{
          id: "agent_run_1",
          turnId: "turn_1",
          status: "running",
          createdAt: "2026-08-13T00:00:00Z",
          startedAt: "2026-08-13T00:00:00Z",
          completedAt: null,
          model: { id: "model_1", displayName: "Clinical" },
          messages: [{ messageId: "message:turn_1:user", role: "user", status: "done", text: "inspect runtime" }],
        }],
      ),
    };
    if (path === "/api/sessions/sess_1/agent-runs/agent_run_1/events") {
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    }
    if (path === "/api/sessions/sess_1/agent-runs/agent_run_1/supplements") {
      supplementBody = request.postDataJSON();
      return route.fulfill({ status: 202, json: {
        agentRunId: "agent_run_1",
        sessionId: "sess_1",
        supplementId: supplementBody.supplementId,
        disposition: "accepted",
        queuedCount: 1,
      } });
    }
    return responses[path]
      ? route.fulfill({ json: responses[path] })
      : route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/agents/centaeris?sessionId=sess_1");
  await page.getByLabel("Context window").click();
  await expect(page.getByText("89.3k / 200k (45%)", { exact: true })).toBeVisible();
  for (const width of [390, 768, 939, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => page.locator(".workspaceContextUsagePanel").evaluate((panel) => {
      const rect = panel.getBoundingClientRect();
      const column = document.querySelector(".workspaceChatColumn").getBoundingClientRect();
      return rect.left >= column.left && rect.right <= column.right
        && rect.top >= column.top && rect.bottom <= column.bottom
        && panel.contains(document.elementFromPoint(rect.left + 2, rect.top + rect.height / 2))
        && panel.contains(document.elementFromPoint(rect.right - 2, rect.top + rect.height / 2));
    }), `context panel must remain inside the chat at ${width}px`).toBe(true);
  }
  await page.locator(".workspaceContextMcpTools > summary").click();
  await expect(page.getByText("mcp:banana:banana · banana_search", { exact: true })).toBeVisible();
  const composer = page.getByLabel("输入消息");
  await expect(page.getByRole("button", { name: "停止" })).toBeEnabled();
  await composer.fill("check the cancellation edge");
  await composer.press("Enter");

  await expect.poll(() => supplementBody?.message).toBe("check the cancellation edge");
  await expect(page.locator(".workspaceUserMessage")).toHaveCount(1);
  await expect(composer).toHaveValue("");
});

async function installChatFixture(page, { deferUpload = false, deferMessage = false, deferEvents = false, staleSessionAfterFinal = false } = {}) {
  const workspace = { id: "ws_1", name: "默认工作区", status: "active", role: "owner" };
  const models = [{ id: "model_1", displayName: "Clinical", provider: "fake", modelName: "fake-model", thinkingMode: "high", thinkingModes: ["low", "high"] }];
  const projects = [];
  const sessions = [{ id: "sess_1", workspaceId: workspace.id, agentId: "centaeris", projectId: null, title: "New chat", origin: "user", status: "active", isPinned: false, isUnread: false, updatedAt: "2026-07-14T00:00:00Z" }];
  const agentRunsBySession = new Map();
  let startUpload;
  let releaseUpload;
  const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
  let startMessage;
  let releaseMessage;
  const messageGate = new Promise((resolve) => { releaseMessage = resolve; });
  let startEvents;
  let releaseEvents;
  const eventsGate = new Promise((resolve) => { releaseEvents = resolve; });
  const fixture = {
    deletedSessionIds: [],
    setAgentRuns(sessionId, agentRuns) {
      agentRunsBySession.set(sessionId, agentRuns);
      sessions.find((session) => session.id === sessionId).hasActiveAgentRun = agentRuns.some((agentRun) => agentRun.status === "running");
    },
    sessions,
    uploadBody: "",
    messageBody: null,
    messageContentType: "",
    uploadStarted: new Promise((resolve) => { startUpload = resolve; }),
    releaseUpload,
    messageStarted: new Promise((resolve) => { startMessage = resolve; }),
    releaseMessage,
    eventsStarted: new Promise((resolve) => { startEvents = resolve; }),
    releaseEvents,
    projects,
  };

  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "test-token" } });
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "user_1", email: "member@example.com", isStaff: false } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [workspace] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", avatarKind: "centaeris", status: "active", deletedAt: null }] } });
    if (path === "/api/models") return route.fulfill({ json: { models } });
    if (path === `/api/workspaces/${workspace.id}/session-projects`) {
      if (request.method() === "GET") return route.fulfill({ json: { projects } });
      const body = request.postDataJSON();
      const project = { id: `session_project_${projects.length + 1}`, workspaceId: workspace.id, agentId: body.agentId, name: body.name.trim(), createdAt: "2026-07-14T00:00:00Z" };
      projects.push(project);
      return route.fulfill({ status: 201, json: { project } });
    }
    if (path === `/api/workspaces/${workspace.id}/sessions`) {
      if (request.method() === "GET") return route.fulfill({ json: { sessions } });
      const body = request.postDataJSON();
      const session = { id: `sess_${sessions.length + 1}`, workspaceId: workspace.id, agentId: body.agentId, projectId: body.projectId || null, title: "New chat", origin: "user", status: "active", isPinned: false, isUnread: false, updatedAt: "2026-07-14T00:00:00Z" };
      sessions.unshift(session);
      return route.fulfill({ status: 201, json: { session } });
    }
    const deleteSessionMatch = path.match(/^\/api\/sessions\/(sess_\d+)$/);
    if (deleteSessionMatch && request.method() === "PATCH") {
      const session = sessions.find((item) => item.id === deleteSessionMatch[1]);
      if (!session) return route.fulfill({ status: 404, json: { error: "session_not_found" } });
      Object.assign(session, request.postDataJSON());
      return route.fulfill({ json: { session } });
    }
    if (deleteSessionMatch && request.method() === "DELETE") {
      fixture.deletedSessionIds.push(deleteSessionMatch[1]);
      const index = sessions.findIndex((session) => session.id === deleteSessionMatch[1]);
      if (index >= 0) sessions.splice(index, 1);
      return route.fulfill({ json: { deleted: true } });
    }
    if (path === "/api/sessions/sess_1/uploads" && request.method() === "POST") {
      fixture.uploadBody = request.postDataBuffer().toString("utf8");
      startUpload();
      if (deferUpload) await uploadGate;
      return route.fulfill({ status: 201, json: {
        libraryObjects: [
          { id: "library_1", displayName: "第一份.txt" },
          { id: "library_2", displayName: "第二份.md" },
        ],
        assets: [
          { id: "asset_1", assetKind: "userLibraryObject", displayName: "第一份.txt", contentType: "text/plain", asset: { id: "library_1" } },
          { id: "asset_2", assetKind: "userLibraryObject", displayName: "第二份.md", contentType: "text/markdown", asset: { id: "library_2" } },
        ],
      } });
    }
    const sessionMatch = path.match(/^\/api\/sessions\/(sess_\d+)\/(assets|history)$/);
    if (sessionMatch) {
      const session = sessions.find((item) => item.id === sessionMatch[1]);
      if (sessionMatch[2] === "assets") return route.fulfill({ json: { assets: [] } });
      return route.fulfill({ json: historyPage(session, agentRunsBySession.get(session.id) || []) });
    }
    const messageMatch = path.match(new RegExp(`^/api/workspaces/${workspace.id}/sessions/(new|sess_\\d+)/messages$`));
    if (messageMatch && request.method() === "POST") {
      const contentType = request.headers()["content-type"] || "";
      const multipartBody = contentType.startsWith("multipart/form-data")
        ? request.postDataBuffer().toString("utf8")
        : "";
      const body = multipartBody
        ? {
            text: multipartField(multipartBody, "text"),
            agentId: multipartField(multipartBody, "agentId"),
            projectId: multipartField(multipartBody, "projectId"),
            modelConfigRef: multipartField(multipartBody, "modelConfigRef"),
            thinkingMode: multipartField(multipartBody, "thinkingMode"),
          }
        : request.postDataJSON();
      fixture.messageBody = multipartBody || body;
      fixture.messageContentType = contentType;
      startMessage();
      if (deferMessage) await messageGate;
      const session = messageMatch[1] === "new"
        ? { id: `sess_${sessions.length + 1}`, workspaceId: workspace.id, agentId: body.agentId, projectId: body.projectId || null, title: "New chat", origin: "user", status: "active", isPinned: false, isUnread: false, updatedAt: "2026-07-14T00:00:00Z" }
        : sessions.find((item) => item.id === messageMatch[1]);
      if (messageMatch[1] === "new") sessions.unshift(session);
      const model = models.find((item) => item.id === body.modelConfigRef);
      const agentRunId = `agent_run_${session.id}`;
      const turnId = `turn_${session.id}`;
      session.title = body.text;
      session.hasActiveAgentRun = true;
      agentRunsBySession.set(session.id, [{
        id: agentRunId,
        turnId,
        status: "completed",
        createdAt: "2026-07-14T00:00:00Z",
        startedAt: "2026-07-14T00:00:00Z",
        completedAt: "2026-07-14T00:00:02Z",
        model,
        messages: [
          { messageId: `message:${turnId}:user`, role: "user", status: "done", text: body.text },
          { messageId: `message:${turnId}:assistant`, role: "assistant", status: "done", text: "这是最小纵切响应。" },
        ],
      }]);
      return route.fulfill({ status: 202, json: { agentRunId, turnId, sessionId: session.id, session, status: "accepted" } });
    }
    const eventMatch = path.match(/^\/api\/sessions\/(sess_\d+)\/agent-runs\/(agent_run_sess_\d+)\/events$/);
    if (eventMatch) {
      startEvents();
      if (deferEvents) await eventsGate;
      const agentRun = (agentRunsBySession.get(eventMatch[1]) || []).find((item) => item.id === eventMatch[2]);
      if (!staleSessionAfterFinal) sessions.find((item) => item.id === eventMatch[1]).hasActiveAgentRun = false;
      const projected = historyPage(sessions.find((item) => item.id === eventMatch[1]), [agentRun]).agentRuns[0];
      return route.fulfill({
        contentType: "text/event-stream",
        body: sse(projected.events.map((item) => ({ schema: "session.stream.item.v1", kind: "committed", agentRunId: agentRun.id, sourceSequence: item.sequence, event: item.event }))),
      });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  return fixture;
}

test("keeps live status at the latest progress and tool disclosures stable across stream updates", async ({ page }) => {
  const fixture = await installChatFixture(page);
  const toolCall = (callId, path) => ({ callId, toolName: "read", toolContractDigest: `sha256:${"a".repeat(64)}`, providerId: "centaeris.builtin", normalizedInput: { path }, displayTarget: path });
  fixture.setAgentRuns("sess_1", [{
    id: "agent_run_live", turnId: "turn_1", status: "running", model: { id: "model_1", displayName: "Clinical" },
    createdAt: "2026-08-31T00:00:00Z", startedAt: "2026-08-31T00:00:00Z", completedAt: null,
    messages: [{ messageId: "user_1", role: "user", text: "inspect files" }],
    records: [
      { type: "phase_event", payload: { stage: "model_process_summary", message: "Stable body before tools." } },
      { type: "tool_call", payload: toolCall("read_1", "first.txt") },
    ],
  }]);
  // Keep one real ReadableStream open so intermediate checks do not invent EOF/reconnects.
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    window.fetch = (input, init) => {
      if (!String(input).endsWith("/agent-runs/agent_run_live/events")) return originalFetch(input, init);
      const body = new ReadableStream({ start(controller) {
        window.__pushChatEvents = (text) => controller.enqueue(new TextEncoder().encode(text));
        window.__disconnectChat = () => controller.error(new TypeError("fixture disconnect"));
      } });
      return Promise.resolve(new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    };
  });
  await page.goto("/w/ws_1/agents/centaeris?sessionId=sess_1");
  const run = page.locator('[data-agent-run-id="agent_run_live"]');
  const status = run.locator(".workspaceLiveStatus");
  const statusText = status.locator(".workspaceLiveStatusText");
  const elapsed = status.locator(".workspaceLiveStatusElapsed");
  const group = run.locator(".workspaceActivityGroup");
  await expect(statusText).toHaveText("Reading first.txt");
  await expect(elapsed).toHaveText(/^\d+h \d{2}m \d{2}s$/);
  await group.click();
  await run.evaluate((element) => {
    window.__toolGroup = element.querySelector(".workspaceActivityGroup");
    window.__stableBody = element.querySelector(".markdownContent");
    window.__stableBodyY = window.__stableBody.getBoundingClientRect().y;
    window.__liveStatus = element.querySelector(".workspaceLiveStatus");
  });
  const elapsedBeforeTick = await elapsed.textContent();
  await expect.poll(() => elapsed.textContent(), { timeout: 2500 }).not.toBe(elapsedBeforeTick);
  expect(await run.evaluate((element) => ({
    status: element.querySelector(".workspaceLiveStatus") === window.__liveStatus,
    group: element.querySelector(".workspaceActivityGroup") === window.__toolGroup,
    body: element.querySelector(".markdownContent") === window.__stableBody,
  }))).toEqual({ status: true, group: true, body: true });
  let sequence = 4;
  const push = async (type, payload, turnId = "turn_1") => {
    sequence += 1;
    const item = committedStreamItem("sess_1", "agent_run_live", sequence, type, payload, turnId);
    item.event.createdAtMs = Date.now();
    await page.evaluate((text) => window.__pushChatEvents(text), `id: ${sequence}-0\ndata: ${JSON.stringify(item)}\n\n`);
  };
  await push("tool_call", toolCall("read_2", "second.txt"));
  await expect(statusText).toHaveText("Reading second.txt");
  await expect(elapsed).toHaveCount(0);
  await expect(group).toHaveAttribute("aria-expanded", "true");
  expect(await group.evaluate((element) => element === window.__toolGroup)).toBe(true);
  await push("tool_result", { callId: "read_2", toolName: "read", resultState: "successWithOutput", modelContent: "second output", summary: "read", latencyMs: 1, operations: [] });
  const second = run.getByRole("button", { name: "second.txt", exact: true });
  await second.click();
  await expect(run.locator(".activityOperationOutput")).toContainText("second output");
  await second.evaluate((element) => { window.__secondOperation = element; });
  await push("tool_result", { callId: "read_1", toolName: "read", resultState: "successWithOutput", modelContent: "first output", summary: "read", latencyMs: 1, operations: [
    { callId: "read_1", toolName: "read", status: "ok", resultState: "successWithOutput", path: "first-a.txt" },
    { callId: "read_1", toolName: "read", status: "ok", resultState: "successWithOutput", path: "first-b.txt" },
  ] });
  await expect(statusText).toHaveText("Thinking");
  await expect(elapsed).toHaveCount(0);
  await expect(second).toHaveAttribute("aria-expanded", "true");
  expect(await second.evaluate((element) => element === window.__secondOperation)).toBe(true);
  await expect(run.locator(".activityOperationOutput")).toContainText("second output");
  const body = await run.evaluate((element) => ({
    same: element.querySelector(".markdownContent") === window.__stableBody,
    displacement: Math.abs(window.__stableBody.getBoundingClientRect().y - window.__stableBodyY),
    statusAfterTools: element.querySelector(".workspaceLiveStatus").getBoundingClientRect().top >= element.querySelector(".workspaceActivityGroups").getBoundingClientRect().bottom,
  }));
  expect(body.same).toBe(true);
  expect(body.displacement).toBeLessThanOrEqual(1);
  expect(body.statusAfterTools).toBe(true);
  console.log("P0_TOOL_STREAM_GEOMETRY", JSON.stringify(body));
  const liveAnswer = {
    schema: "session.stream.item.v1",
    kind: "live",
    agentRunId: "agent_run_live",
    afterSequence: sequence,
    revision: 1,
    turnId: "turn_1",
    messageId: "message:turn_1:assistant",
    text: "First answer in progress.",
  };
  await page.evaluate((text) => window.__pushChatEvents(text), `data: ${JSON.stringify(liveAnswer)}\n\n`);
  await expect(run.getByText("First answer in progress.", { exact: true })).toBeVisible();
  await expect(status).toHaveCount(0);
  await push("assistant_message", { messageId: "answer_1", modelMarkdown: "First answer.", artifactRefs: [], status: "done" });
  await expect(run.getByText("First answer.", { exact: true })).toBeVisible();
  await expect(status).toHaveCount(0);
  await push("tool_call", toolCall("read_3", "third.txt"), "turn_2");
  await expect(statusText).toHaveText("Reading third.txt");
  await push("tool_result", { callId: "read_3", toolName: "read", resultState: "successNoOutput", modelContent: "", summary: "read", latencyMs: 1, operations: [] }, "turn_2");
  await expect(statusText).toHaveText("Thinking");
  await page.evaluate(() => window.__disconnectChat());
  await expect(statusText).toHaveText("Reconnecting");
  await expect(group.first()).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => statusText.textContent()).toBe("Thinking");
  await push("agent_run_completed", { doneReason: "finalized" }, "turn_2");
  await expect(status).toHaveCount(0);
  await expect(second).toHaveAttribute("aria-expanded", "true");
});

test("keeps route-intended layouts while session navigation is loading", async ({ page }) => {
  const fixture = await installChatFixture(page);
  let releaseHomeSessions;
  let releaseConversationSessions;
  let startHomeSessions;
  let startConversationSessions;
  let requestCount = 0;
  const homeSessionsGate = new Promise((resolve) => { releaseHomeSessions = resolve; });
  const conversationSessionsGate = new Promise((resolve) => { releaseConversationSessions = resolve; });
  const homeSessionsStarted = new Promise((resolve) => { startHomeSessions = resolve; });
  const conversationSessionsStarted = new Promise((resolve) => { startConversationSessions = resolve; });
  await page.route("http://localhost:8000/api/workspaces/ws_1/sessions?agentId=centaeris", async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      startHomeSessions();
      await homeSessionsGate;
    } else {
      startConversationSessions();
      await conversationSessionsGate;
    }
    await route.fulfill({ json: { sessions: fixture.sessions } });
  });

  await page.goto("/w/ws_1/app");
  await homeSessionsStarted;
  await expect(page.locator(".workspaceComposer")).toHaveClass(/shComposerHero/);
  await expect(page.getByText("正在读取会话…", { exact: true })).toHaveCount(0);
  releaseHomeSessions();
  await expect(page.getByRole("button", { name: "AI 模型", exact: true })).toContainText("Clinical");

  await page.goto("/w/ws_1/agents/centaeris?sessionId=sess_1");
  await conversationSessionsStarted;
  await expect(page.locator(".workspaceComposer")).not.toHaveClass(/shComposerHero/);
  releaseConversationSessions();
  await expect(page.getByTestId("active-session")).toContainText("New chat");
});

test("isolates a broken AgentRun while rendering contracted dynamic tools", async ({ page }) => {
  const fixture = await installChatFixture(page, { deferEvents: true });
  fixture.setAgentRuns("sess_1", [{
    id: "agent_run_broken",
    turnId: "turn_broken",
    status: "completed",
    createdAt: "2026-07-14T00:00:00Z",
    startedAt: "2026-07-14T00:00:00Z",
    completedAt: "2026-07-14T00:00:01Z",
    model: { id: "model_1", displayName: "Clinical" },
    messages: [{ messageId: "message:broken:user", role: "user", status: "done", text: "损坏的历史记录" }],
    records: [{
      type: "tool_call",
      payload: { callId: "banana_1", toolName: "banana", toolContractDigest: `sha256:${"b".repeat(64)}`, providerId: "centaeris.builtin", normalizedInput: {}, displayTarget: "banana" },
    }],
  }, {
    id: "agent_run_sess_1",
    turnId: "turn_sess_1",
    status: "running",
    createdAt: "2026-07-14T00:00:02Z",
    startedAt: "2026-07-14T00:00:02Z",
    completedAt: null,
    model: { id: "model_1", displayName: "Clinical" },
    messages: [{ messageId: "message:dynamic:user", role: "user", status: "done", text: "检索上海市校规" }],
    records: [{
      type: "tool_call",
      payload: { callId: "banana_1", toolName: "banana_fetch", toolContractDigest: `sha256:${"c".repeat(64)}`, providerId: "mcp:banana:banana", normalizedInput: { title: "上海市校规" }, displayTarget: "上海市校规" },
    }],
  }]);

  await page.goto("/w/ws_1/agents/centaeris?sessionId=sess_1");

  await expect(page.getByRole("heading", { name: "页面加载失败" })).toHaveCount(0);
  const isolatedFailure = page.getByRole("alert").filter({ hasText: "此轮内容暂时无法显示" });
  await expect(isolatedFailure).toContainText("其他会话功能仍可使用");
  await expect(isolatedFailure.getByRole("button", { name: "重新读取" })).toBeVisible();
  await expect(page.getByText("Using 上海市校规", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeEnabled();
});

test("keeps a failed run usable without a red retry banner", async ({ page }) => {
  const fixture = await installChatFixture(page);
  fixture.setAgentRuns("sess_1", [{
    id: "agent_run_failed",
    turnId: "turn_failed",
    status: "failed",
    createdAt: "2026-08-30T00:00:00Z",
    startedAt: "2026-08-30T00:00:00Z",
    completedAt: "2026-08-30T00:00:01Z",
    model: { id: "model_1", displayName: "Clinical" },
    messages: [
      { messageId: "message:failed:user", role: "user", status: "done", text: "继续完成本轮" },
      { messageId: "message:failed:assistant", role: "assistant", status: "error", text: "已有可继续使用的结果。" },
    ],
  }]);

  await page.goto("/w/ws_1/agents/centaeris?sessionId=sess_1");
  await expect(page.getByText("已有可继续使用的结果。", { exact: true })).toBeVisible();
  await expect(page.getByText("本轮运行未完成，请重试。", { exact: true })).toHaveCount(0);
  await expect(page.locator(".workspaceRunNotice.isError")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "输入消息", exact: true })).toBeEnabled();
});

test("composer reverses Enter behavior when the preference is enabled", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("centaeris:composer-enter-new-line:v1:user_1", "1"));
  const fixture = await installChatFixture(page);
  await page.goto("/w/ws_1/agents/centaeris");

  const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
  await composer.fill("检查发送快捷键");
  await composer.press("Enter");
  await expect(composer).toHaveValue("检查发送快捷键\n");
  expect(fixture.messageBody).toBeNull();

  await composer.press("Control+Enter");
  await expect.poll(() => fixture.messageBody?.text).toBe("检查发送快捷键");
});

test("composer uploads multiple materials in one request", async ({ page }) => {
  const fixture = await installChatFixture(page);
  await page.goto("/w/ws_1/agents/centaeris");
  await expect(page.getByTestId("active-session")).toContainText("New chat");

  await page.getByLabel("选择一个或多个材料").setInputFiles([
    { name: "第一份.txt", mimeType: "text/plain", buffer: Buffer.from("first") },
    { name: "第二份.md", mimeType: "text/markdown", buffer: Buffer.from("second") },
  ]);

  await expect(page.getByText("第一份.txt", { exact: true })).toBeVisible();
  await expect(page.getByText("第二份.md", { exact: true })).toBeVisible();
  expect(fixture.uploadBody.match(/name="files"/g)).toHaveLength(2);

  await page.getByRole("button", { name: "思考力度", exact: true }).click();
  const thinkingPicker = page.getByLabel("选择思考力度", { exact: true });
  await expect(thinkingPicker.getByRole("button", { name: "模型默认", exact: true })).toHaveCount(0);
  await expect(thinkingPicker.getByRole("button", { name: "高", exact: true })).toHaveAttribute("aria-pressed", "true");
  await thinkingPicker.getByRole("button", { name: "低", exact: true }).click();

  await page.getByRole("textbox", { name: "输入消息", exact: true }).fill("读取这两份材料");
  await page.getByRole("textbox", { name: "输入消息", exact: true }).press("Enter");
  await expect.poll(() => fixture.messageBody?.attachmentRefs).toEqual(["asset_1", "asset_2"]);
  expect(fixture.messageBody.thinkingMode).toBe("low");
});

test("new-session first message submits attachments atomically", async ({ page }) => {
  const fixture = await installChatFixture(page);
  await page.goto("/w/ws_1/agents/centaeris");
  await page.getByRole("button", { name: "新建一般会话", exact: true }).click();

  await expect(page.getByRole("button", { name: "添加", exact: true })).toBeEnabled();
  await page.getByLabel("选择一个或多个材料").setInputFiles({
    name: "policy.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 real text fixture"),
  });
  await expect(page.getByText("policy.pdf", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "输入消息", exact: true }).fill("读取 PDF");
  await page.getByRole("textbox", { name: "输入消息", exact: true }).press("Enter");

  await expect.poll(() => fixture.messageContentType).toMatch(/^multipart\/form-data;/);
  expect(fixture.uploadBody).toBe("");
  expect(fixture.messageBody).toContain('name="text"');
  expect(fixture.messageBody).toContain("读取 PDF");
  expect(fixture.messageBody).toContain('name="files"');
  expect(fixture.messageBody).toContain('name="thinkingMode"');
  expect(fixture.messageBody).toContain("high");
  expect(fixture.messageBody).toContain('filename="policy.pdf"');
});

test("late batch upload response cannot contaminate a different session", async ({ page }) => {
  const fixture = await installChatFixture(page, { deferUpload: true });
  await page.goto("/w/ws_1/agents/centaeris");
  await expect(page.getByTestId("active-session")).toContainText("New chat");

  const uploadAction = page.getByLabel("选择一个或多个材料").setInputFiles([
    { name: "第一份.txt", mimeType: "text/plain", buffer: Buffer.from("first") },
    { name: "第二份.md", mimeType: "text/markdown", buffer: Buffer.from("second") },
  ]);
  await fixture.uploadStarted;
  await page.getByRole("button", { name: "新建一般会话", exact: true }).click();
  fixture.releaseUpload();
  await uploadAction;

  await expect(page.getByText("第一份.txt", { exact: true })).toHaveCount(0);
  await expect(page.getByText("第二份.md", { exact: true })).toHaveCount(0);
});

test("streams one answer block, ignores a stale active-session summary, and restores durable history", async ({ page }) => {
  await installChatFixture(page, { staleSessionAfterFinal: true });
  await page.goto("/w/ws_1/agents/centaeris");
  await page.getByRole("button", { name: "新建一般会话", exact: true }).click();
  await expect(page.getByTestId("active-session")).toHaveCount(0);
  await expect(page.locator(".shHomeAvatar")).toBeVisible();
  const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
  await composer.fill("Playwright 工作台回归");
  await composer.press("Enter");

  const currentRun = page.getByRole("article").filter({ hasText: "Playwright 工作台回归" });
  await expect(currentRun.getByText("这是最小纵切响应。", { exact: true })).toBeVisible();
  await expect(currentRun.getByText("正在生成回答…", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("运行中", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("active-session")).toContainText("Playwright 工作台回归");
  await expect(currentRun).not.toContainText("准备上下文");
  await expect(currentRun).not.toContainText("生成回答");

  await page.reload();
  const restoredRun = page.getByRole("article").filter({ hasText: "Playwright 工作台回归" });
  await expect(restoredRun.getByText("这是最小纵切响应。", { exact: true })).toBeVisible();
  await expect(page.getByTestId("active-session")).toContainText("Playwright 工作台回归");
});

test("unlocks drafting after 202 and renders sealed Markdown while streaming", async ({ page }) => {
  await page.addInitScript(() => {
    window.__chatRenderMetrics = [];
    window.addEventListener("centaeris:chat-render-telemetry", (event) => {
      const metric = event.detail;
      const domText = document.querySelector(`[data-agent-run-id="${metric.agentRunId}"]`)?.textContent || "";
      window.__chatRenderMetrics.push({ ...metric, domText });
    });
  });
  const session = { id: "sess_1", workspaceId: "ws_1", agentId: "centaeris", title: "流式检查", origin: "user", status: "active" };
  let eventAttempt = 0;
  let releaseFinal;
  let markFinalRequestStarted;
  const finalGate = new Promise((resolve) => { releaseFinal = resolve; });
  const finalRequestStarted = new Promise((resolve) => { markFinalRequestStarted = resolve; });
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "test-token" } });
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "1", email: "member@example.com", isStaff: false } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "默认工作区", status: "active", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", avatarKind: "centaeris", status: "active", deletedAt: null }] } });
    if (path === "/api/models") return route.fulfill({ json: { models: [{ id: "model_1", displayName: "Clinical", provider: "fake", modelName: "fake-model" }] } });
    if (path === "/api/workspaces/ws_1/session-projects") return route.fulfill({ json: { projects: [] } });
    if (path === "/api/workspaces/ws_1/sessions") return route.fulfill({ json: { sessions: [session] } });
    if (path === "/api/sessions/sess_1/assets") return route.fulfill({ json: { assets: [] } });
    if (path === "/api/sessions/sess_1/history") return route.fulfill({ json: historyPage(session, []) });
    if (path === "/api/workspaces/ws_1/sessions/sess_1/messages") {
      return route.fulfill({ status: 202, json: { agentRunId: "agent_run_1", turnId: "turn_1", sessionId: "sess_1", session: { ...session, title: "检查流式渲染" }, status: "accepted" } });
    }
    if (path === "/api/sessions/sess_1/agent-runs/agent_run_1/events") {
      eventAttempt += 1;
      if (eventAttempt === 1) {
        let text = "";
        const body = sse(["#", " ", "流式标题", "\n\n", "-", " ", "流式项目", "\n\n", "**流式原文**"].map((delta, index) => {
          text += delta;
          return liveStreamItem("agent_run_1", index + 1, text, "turn_1");
        }));
        return route.fulfill({ contentType: "text/event-stream", body });
      }
      markFinalRequestStarted();
      await finalGate;
      return route.fulfill({ contentType: "text/event-stream", body: sse([
        committedStreamItem("sess_1", "agent_run_1", 3, "artifact_published", { artifactRef: "artifact:trusted", filename: "报告.docx" }, "turn_1"),
        committedStreamItem("sess_1", "agent_run_1", 4, "assistant_message", { messageId: "message:turn_1:assistant", modelMarkdown: "**终态加粗**\n\n[伪造附件](/api/artifacts/forged/download)", artifactRefs: ["artifact:trusted"], status: "done" }, "turn_1"),
        committedStreamItem("sess_1", "agent_run_1", 5, "agent_run_completed", { doneReason: "finalized" }, "turn_1"),
      ]) });
    }
    if (path === "/api/artifacts/trusted/download") {
      const body = "预览正文内容";
      return route.fulfill({
        status: 200,
        contentType: "text/plain",
        headers: { "Content-Length": String(Buffer.byteLength(body)) },
        body,
      });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/agents/centaeris");
  const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill("检查流式渲染");
  await composer.press("Enter");
  await finalRequestStarted;

  const currentRun = page.locator('[data-agent-run-id="agent_run_1"]');
  await expect(currentRun.locator(".workspaceAnswerText.isStreaming h1")).toHaveText("流式标题");
  await expect(currentRun.locator(".workspaceAnswerText.isStreaming ul")).toContainText("流式项目");
  await expect(currentRun.locator(".workspaceAnswerText.isStreaming strong")).toHaveText("流式原文");
  await expect.poll(() => page.evaluate(() => window.__chatRenderMetrics.find((metric) => metric.domText.includes("流式原文")) || null)).not.toBeNull();
  const renderMetric = await page.evaluate(() => window.__chatRenderMetrics.find((metric) => metric.domText.includes("流式原文")));
  expect(renderMetric.schema).toBe("workspace.chat_render_telemetry.v1");
  expect(renderMetric.streamItemKind).toBe("live");
  expect(renderMetric.acceptedAt).toBeLessThanOrEqual(renderMetric.reducerAppliedAt);
  expect(renderMetric.reducerAppliedAt).toBeLessThanOrEqual(renderMetric.domCommitAt);
  expect(renderMetric.domCommitAt).toBeLessThanOrEqual(renderMetric.domPaintBoundaryAt);
  for (const phase of [
    "acceptedToReducerMs",
    "reducerToDomCommitMs",
    "domCommitToPaintBoundaryMs",
    "acceptedToDomPaintBoundaryMs",
  ]) expect(renderMetric[phase]).toBeGreaterThanOrEqual(0);
  console.log("WEB_01_BROWSER_SAMPLE", JSON.stringify({
    acceptedToReducerMs: renderMetric.acceptedToReducerMs,
    reducerToDomCommitMs: renderMetric.reducerToDomCommitMs,
    domCommitToPaintBoundaryMs: renderMetric.domCommitToPaintBoundaryMs,
    acceptedToDomPaintBoundaryMs: renderMetric.acceptedToDomPaintBoundaryMs,
  }));
  await expect(currentRun.locator(".workspaceProcessHeader")).toHaveCount(0);
  await expect(currentRun.locator(".workspaceLiveStatus")).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await composer.fill("下一条草稿");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "输入", exact: true })).toHaveCount(0);

  releaseFinal();
  await expect(currentRun.getByText("终态加粗", { exact: true })).toBeVisible();
  await expect(currentRun.locator(".workspaceLiveStatus")).toHaveCount(0);
  await expect(currentRun.getByRole("link", { name: "报告.docx", exact: true })).toHaveAttribute("href", "/api/artifacts/trusted/download");
  await expect(currentRun.getByText("伪造附件", { exact: true })).toBeVisible();
  await expect(currentRun.getByRole("link", { name: "伪造附件", exact: true })).toHaveCount(0);
  await currentRun.getByRole("link", { name: "报告.docx", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "文件预览", exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "文件预览", exact: true })).toContainText("预览正文内容");
  await expect(composer).toHaveValue("下一条草稿");
  await expect(page.getByRole("button", { name: "输入", exact: true })).toBeEnabled();
});

test("renders coalesced live Markdown without remounting or losing the end anchor", async ({ page }) => {
  const session = { id: "sess_1", workspaceId: "ws_1", agentId: "centaeris", projectId: null, title: "稳定视觉", origin: "user", status: "active", isPinned: false, isUnread: false, hasActiveAgentRun: false, updatedAt: "2026-08-30T00:00:00Z" };
  const model = { id: "model_1", displayName: "Clinical", provider: "fake", modelName: "fake-model" };
  const userText = "检查本地稳定视觉";
  const firstTail = "甲".repeat(2500);
  const secondTail = "乙".repeat(2500);
  const replacementTail = "修".repeat(1800);
  const finalTail = "终".repeat(400);
  const firstBurst = `## 稳定标题\n\n${firstTail}`;
  const secondBurst = `${firstBurst}\n\n${secondTail}`;
  const replacementText = `## 修订标题\n\n${replacementTail}`;
  const finalText = `${replacementText}\n\n${finalTail}`;
  const firstRenderedText = `稳定标题${firstTail}`;
  const secondRenderedText = `${firstRenderedText}${secondTail}`;
  const replacementRenderedText = `修订标题${replacementTail}`;
  const finalRenderedText = `${replacementRenderedText}${finalTail}`;
  let completed = false;
  let eventAttempt = 0;
  let markFirstRequested;
  let markSecondRequested;
  let markReplacementRequested;
  let markTerminalRequested;
  let releaseFirst;
  let releaseSecond;
  let releaseReplacement;
  let releaseTerminal;
  const firstRequested = new Promise((resolve) => { markFirstRequested = resolve; });
  const secondRequested = new Promise((resolve) => { markSecondRequested = resolve; });
  const replacementRequested = new Promise((resolve) => { markReplacementRequested = resolve; });
  const terminalRequested = new Promise((resolve) => { markTerminalRequested = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const replacementGate = new Promise((resolve) => { releaseReplacement = resolve; });
  const terminalGate = new Promise((resolve) => { releaseTerminal = resolve; });

  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "test-token" } });
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "user_1", email: "member@example.com", isStaff: false } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "默认工作区", status: "active", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", avatarKind: "centaeris", status: "active", deletedAt: null }] } });
    if (path === "/api/models") return route.fulfill({ json: { models: [model] } });
    if (path === "/api/workspaces/ws_1/session-projects") return route.fulfill({ json: { projects: [] } });
    if (path === "/api/workspaces/ws_1/sessions") return route.fulfill({ json: { sessions: [session] } });
    if (path === "/api/sessions/sess_1/assets") return route.fulfill({ json: { assets: [] } });
    if (path === "/api/sessions/sess_1/history") {
      const agentRuns = completed ? [{
        id: "agent_run_paced",
        turnId: "turn_paced",
        status: "completed",
        createdAt: "2026-08-30T00:00:00Z",
        startedAt: "2026-08-30T00:00:00Z",
        completedAt: "2026-08-30T00:00:02Z",
        model,
        messages: [
          { messageId: "message:turn_paced:user", turnId: "turn_paced", role: "user", status: "done", text: userText },
          { messageId: "message:turn_paced:assistant", turnId: "turn_paced", role: "assistant", status: "done", text: finalText },
        ],
      }] : [];
      return route.fulfill({ json: historyPage(session, agentRuns) });
    }
    if (path === "/api/workspaces/ws_1/sessions/sess_1/messages") {
      session.hasActiveAgentRun = true;
      return route.fulfill({ status: 202, json: { agentRunId: "agent_run_paced", turnId: "turn_paced", sessionId: "sess_1", session, status: "accepted" } });
    }
    if (path === "/api/sessions/sess_1/agent-runs/agent_run_paced/events") {
      eventAttempt += 1;
      if (eventAttempt === 1) {
        markFirstRequested();
        await firstGate;
        return route.fulfill({ contentType: "text/event-stream", body: sse([
          committedStreamItem("sess_1", "agent_run_paced", 1, "agent_run_started", { userObjective: userText }, "turn_paced"),
          committedStreamItem("sess_1", "agent_run_paced", 2, "user_message", { messageId: "message:turn_paced:user", text: userText, attachments: [] }, "turn_paced"),
          liveStreamItem("agent_run_paced", 1, firstBurst, "turn_paced"),
        ]) });
      }
      if (eventAttempt === 2) {
        markSecondRequested();
        await secondGate;
        return route.fulfill({ contentType: "text/event-stream", body: sse([
          liveStreamItem("agent_run_paced", 2, secondBurst, "turn_paced"),
        ]) });
      }
      if (eventAttempt === 3) {
        markReplacementRequested();
        await replacementGate;
        return route.fulfill({ contentType: "text/event-stream", body: sse([
          liveStreamItem("agent_run_paced", 3, replacementText, "turn_paced"),
        ]) });
      }
      markTerminalRequested();
      await terminalGate;
      completed = true;
      session.hasActiveAgentRun = false;
      return route.fulfill({ contentType: "text/event-stream", body: sse([
        committedStreamItem("sess_1", "agent_run_paced", 3, "assistant_message", { messageId: "message:turn_paced:assistant", modelMarkdown: finalText, artifactRefs: [], status: "done" }, "turn_paced"),
        committedStreamItem("sess_1", "agent_run_paced", 4, "agent_run_completed", { doneReason: "finalized" }, "turn_paced"),
      ]) });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/agents/centaeris?sessionId=sess_1");
  const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
  await composer.fill(userText);
  await composer.press("Enter");
  await firstRequested;
  const currentRun = page.locator('[data-agent-run-id="agent_run_paced"]');
  await expect(currentRun.getByText("Thinking", { exact: true })).toBeVisible();

  releaseFirst();
  const streamingText = currentRun.locator(".workspaceAnswerText.isStreaming .streamingMarkdownContent");
  const streamingAnswer = currentRun.locator(".workspaceAnswerText.isStreaming");
  const messageList = page.getByTestId("virtual-agent-run-list");
  await messageList.evaluate((element) => {
    window.__jumpToLatestAppearedWhileFollowing = false;
    window.__jumpToLatestObserver = new MutationObserver((records) => {
      if (records.some((record) => [...record.addedNodes].some((node) => (
        node instanceof Element
        && (node.matches(".workspaceJumpToLatest") || node.querySelector(".workspaceJumpToLatest"))
      )))) window.__jumpToLatestAppearedWhileFollowing = true;
    });
    window.__jumpToLatestObserver.observe(element.parentElement, { childList: true, subtree: true });
  });
  await expect(currentRun.locator(".workspaceLiveStatusText")).toHaveText("Reconnecting");
  await expect(streamingText).toBeVisible();
  await expect(currentRun.locator(".workspaceLiveStatus")).toHaveCSS("opacity", "1");
  await expect(currentRun.locator(".workspaceLiveStatus")).toHaveCSS("position", "static");
  await expect(streamingAnswer).toHaveCSS("opacity", "1");
  await expect(streamingText).toHaveText(firstRenderedText);
  await expect.poll(() => messageList.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => window.__jumpToLatestAppearedWhileFollowing)).toBe(false);
  await page.evaluate(() => window.__jumpToLatestObserver.disconnect());
  await streamingText.evaluate((element) => {
    window.__streamingMarkdownRoot = element;
    window.__sealedMarkdownBlock = element.querySelector(".markdownContent");
    window.__sealedMarkdownBlockOffsetTop = window.__sealedMarkdownBlock?.offsetTop;
  });

  await secondRequested;
  await messageList.evaluate((element) => {
    window.__latestScrollBehaviors = [];
    const scrollTo = element.scrollTo.bind(element);
    element.scrollTo = (options) => {
      window.__latestScrollBehaviors.push(options.behavior);
      scrollTo(options);
    };
    element.scrollTop = Math.min(
      120,
      Math.max(1, element.scrollHeight - element.clientHeight - 10),
    );
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(page.getByRole("button", { name: "回到最新", exact: true })).toBeVisible();
  const detachedScrollTop = await messageList.evaluate((element) => element.scrollTop);
  expect(detachedScrollTop).toBeGreaterThan(0);
  await page.waitForTimeout(250);
  releaseSecond();
  await expect(streamingText).toHaveText(secondRenderedText);
  expect(await streamingText.evaluate((element) => ({
    rootIsStable: element === window.__streamingMarkdownRoot,
    sealedBlockIsStable: element.querySelector(".markdownContent") === window.__sealedMarkdownBlock,
    sealedBlockOffsetIsStable: element.querySelector(".markdownContent")?.offsetTop === window.__sealedMarkdownBlockOffsetTop,
  }))).toEqual({
    rootIsStable: true,
    sealedBlockIsStable: true,
    sealedBlockOffsetIsStable: true,
  });
  expect(Math.abs(await messageList.evaluate((element) => element.scrollTop) - detachedScrollTop)).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: "回到最新", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "回到最新", exact: true }).click();
  await expect.poll(() => messageList.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => window.__latestScrollBehaviors[0])).toBe("auto");

  await messageList.evaluate((element) => {
    window.__latestScrollBehaviors = [];
    element.scrollTop = element.scrollHeight - element.clientHeight - 100;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(page.getByRole("button", { name: "回到最新", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "回到最新", exact: true }).click();
  expect(await page.evaluate(() => window.__latestScrollBehaviors[0])).toBe("smooth");
  await expect.poll(() => messageList.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2);

  await replacementRequested;
  releaseReplacement();
  await expect(streamingText).toHaveText(replacementRenderedText, { timeout: 300 });
  await expect.poll(() => messageList.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2);

  await terminalRequested;
  releaseTerminal();
  const terminalText = currentRun.locator(".workspaceTerminalAnswer .streamingMarkdownContent");
  await expect(terminalText).toHaveText(finalRenderedText, { timeout: 300 });
  expect(await terminalText.evaluate((element) => element === window.__streamingMarkdownRoot)).toBe(true);
  await expect.poll(() => messageList.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2);

  await page.reload();
  const restoredRun = page.locator('[data-agent-run-id="agent_run_paced"]');
  await expect(restoredRun.locator(".workspaceTerminalAnswer .markdownContent")).toHaveText(finalRenderedText);
  await expect(restoredRun.locator(".streamingMarkdownContent")).toHaveCount(0);
});

test("keeps an accepted AgentRun owned by durable truth after a renderer reducer failure", async ({ page }) => {
  const session = { id: "sess_1", workspaceId: "ws_1", agentId: "centaeris", title: "显示链检查", origin: "user", status: "active" };
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "test-token" } });
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "1", email: "member@example.com", isStaff: false } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "默认工作区", status: "active", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", avatarKind: "centaeris", status: "active", deletedAt: null }] } });
    if (path === "/api/models") return route.fulfill({ json: { models: [{ id: "model_1", displayName: "Clinical", provider: "fake", modelName: "fake-model" }] } });
    if (path === "/api/workspaces/ws_1/session-projects") return route.fulfill({ json: { projects: [] } });
    if (path === "/api/workspaces/ws_1/sessions") return route.fulfill({ json: { sessions: [session] } });
    if (path === "/api/sessions/sess_1/assets") return route.fulfill({ json: { assets: [] } });
    if (path === "/api/sessions/sess_1/history") return route.fulfill({ json: historyPage(session, []) });
    if (path === "/api/workspaces/ws_1/sessions/sess_1/messages") {
      return route.fulfill({
        status: 202,
        json: { agentRunId: "agent_run_1", turnId: "turn_1", sessionId: "sess_1", session, status: "accepted" },
      });
    }
    if (path === "/api/sessions/sess_1/agent-runs/agent_run_1/events") {
      return route.fulfill({
        contentType: "text/event-stream",
        body: sse([{ ...liveStreamItem("agent_run_1", 1, "banana", "turn_1"), messageId: "message:turn_1:user", banana: true }]),
      });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/agents/centaeris");
  const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill("触发显示链失败");
  await composer.press("Enter");

  const currentRun = page.getByRole("article").filter({ hasText: "触发显示链失败" });
  await expect(currentRun.getByRole("alert")).toContainText("此轮内容暂时无法显示");
  await expect(currentRun.getByRole("button", { name: "重新读取" })).toBeVisible();
  await expect(currentRun.getByText("运行已终止。", { exact: true })).toHaveCount(0);
  await composer.fill("仍可继续起草");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "输入", exact: true })).toHaveCount(0);
});

test("rejects a history page bound to a different workspace", async ({ page }) => {
  const session = { id: "sess_1", workspaceId: "ws_1", title: "历史绑定检查", origin: "user", status: "active" };
  await page.route("http://localhost:8000/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "1", email: "member@example.com", isStaff: false } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "默认工作区", status: "active", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", avatarKind: "centaeris", status: "active", deletedAt: null }] } });
    if (path === "/api/models") return route.fulfill({ json: { models: [{ id: "model_1", displayName: "Clinical", provider: "fake", modelName: "fake-model" }] } });
    if (path === "/api/workspaces/ws_1/session-projects") return route.fulfill({ json: { projects: [] } });
    if (path === "/api/workspaces/ws_1/sessions") return route.fulfill({ json: { sessions: [session] } });
    if (path === "/api/sessions/sess_1/assets") return route.fulfill({ json: { assets: [] } });
    if (path === "/api/sessions/sess_1/history") {
      return route.fulfill({ json: historyPage({ ...session, workspaceId: "workspace_banana" }, []) });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/agents/centaeris");
  await expect(page.getByText("无法读取会话记录，请刷新后重试。", { exact: true })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
});

test("moves the first input into the conversation before startup and preserves it across acceptance", async ({ page }) => {
  const fixture = await installChatFixture(page, { deferMessage: true, deferEvents: true });
  await page.goto("/w/ws_1/app");
  await page.getByRole("textbox", { name: "输入消息", exact: true }).evaluate((element) => { window.__entryComposer = element; });

  const composer = page.getByRole("textbox", { name: "输入消息", exact: true }).locator("..");
  const startBox = await composer.boundingBox();
  await page.getByRole("textbox", { name: "输入消息", exact: true }).fill("首条消息连续动效");
  await page.getByRole("textbox", { name: "输入消息", exact: true }).press("Enter");
  await fixture.messageStarted;

  const pendingRun = page.locator('[data-agent-run-id^="pending:"]');
  await expect(pendingRun.locator(".workspaceUserMessage")).toHaveText("首条消息连续动效");
  await expect(pendingRun.locator(".workspaceUserMessageStack")).toHaveClass(/isConversationEntry/);
  await expect(pendingRun.locator(".workspaceLiveStatus")).toBeVisible();
  expect(await pendingRun.locator(".workspaceLiveStatusText").evaluate((element) => getComputedStyle(element).color)).not.toBe("rgba(0, 0, 0, 0)");
  expect(await pendingRun.evaluate((node) => {
    const userMessage = node.querySelector(".workspaceUserMessage");
    const thinking = node.querySelector(".workspaceLiveStatus");
    return Boolean(userMessage && thinking && (userMessage.compareDocumentPosition(thinking) & Node.DOCUMENT_POSITION_FOLLOWING));
  })).toBe(true);
  await expect(page.getByText(/发送中|正在排队|正在准备运行环境/)).toHaveCount(0);

  await page.waitForTimeout(360);
  const endBox = await composer.boundingBox();
  expect(endBox.y).toBeGreaterThan(startBox.y + 40);

  fixture.releaseMessage();
  await fixture.eventsStarted;
  await expect(page).toHaveURL(/sessionId=sess_2/);
  const acceptedRun = page.locator('[data-agent-run-id="agent_run_sess_2"]');
  await expect(acceptedRun.locator(".workspaceUserMessage")).toHaveText("首条消息连续动效");
  await expect(acceptedRun.locator(".workspaceLiveStatus")).toBeVisible();
  expect(await page.getByRole("textbox", { name: "输入消息", exact: true }).evaluate((element) => element === window.__entryComposer)).toBe(true);

  fixture.releaseEvents();
  await expect(acceptedRun.getByText("这是最小纵切响应。", { exact: true })).toBeVisible();
});

test("accepts the first session behind settings without replacing the draft host", async ({ page }) => {
  const fixture = await installChatFixture(page, { deferMessage: true, deferEvents: true });
  let messageRequests = 0;
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/messages")) messageRequests += 1; });
  await page.goto("/w/ws_1/app");
  const composer = page.locator("#messageDraft");
  await composer.fill("Accept behind settings");
  await composer.evaluate((element) => { window.__acceptComposer = element; });
  await composer.press("Enter");
  await fixture.messageStarted;
  await page.getByRole("button", { name: "默认工作区 工作区菜单" }).click();
  await page.getByRole("link", { name: "设置", exact: true }).click();
  const preferences = page.getByRole("dialog", { name: "偏好", exact: true });
  await expect(preferences).toBeVisible();
  fixture.releaseMessage();
  await fixture.eventsStarted;
  await expect(preferences).toBeVisible();
  await expect(page).toHaveURL(/\/w\/ws_1\/settings\/preferences$/);
  const acceptedRun = page.locator('[data-agent-run-id="agent_run_sess_2"]');
  await expect(acceptedRun.locator(".workspaceUserMessage")).toHaveText("Accept behind settings");
  await preferences.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/centaeris\?sessionId=sess_2$/);
  await expect(acceptedRun.locator(".workspaceLiveStatus")).toBeVisible();
  expect(await composer.evaluate((element) => element === window.__acceptComposer)).toBe(true);
  expect(messageRequests).toBe(1);
  fixture.releaseEvents();
  await expect(acceptedRun.getByText("这是最小纵切响应。", { exact: true })).toBeVisible();
});

for (const destination of ["session", "outside chat"]) {
test(`ignores late first-message acceptance after navigating to ${destination}`, async ({ page }) => {
  const fixture = await installChatFixture(page, { deferMessage: true });
  fixture.sessions[0].title = "Existing conversation";
  let messageRequests = 0;
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/messages")) messageRequests += 1; });
  await page.goto("/w/ws_1/app");
  await page.locator("#messageDraft").fill("Late acceptance");
  await page.locator("#messageDraft").press("Enter");
  await fixture.messageStarted;
  if (destination === "session") {
    await page.getByRole("tab", { name: "对话", exact: true }).click();
    await page.getByRole("button", { name: "Existing conversation", exact: true }).click();
    await expect(page).toHaveURL(/sessionId=sess_1$/);
    await expect(page.locator("#messageDraft")).toBeEnabled();
    await page.locator("#messageDraft").fill("New view draft");
  } else {
    await page.getByRole("link", { name: "添加代理", exact: true }).click();
    await expect(page).toHaveURL(/\/agents\/new$/);
  }
  const response = page.waitForResponse((item) => new URL(item.url()).pathname.endsWith("/sessions/new/messages"));
  fixture.releaseMessage();
  await response;
  await page.waitForTimeout(150);
  await expect(page).toHaveURL(destination === "session" ? /sessionId=sess_1$/ : /\/agents\/new$/);
  if (destination === "session") await expect(page.locator("#messageDraft")).toHaveValue("New view draft");
  await expect(page.locator('[data-agent-run-id="agent_run_sess_2"]')).toHaveCount(0);
  expect(messageRequests).toBe(1);
});
}

test("keeps paged history DOM bounded while loading older AgentRuns", async ({ page }) => {
  const session = { id: "sess_1", workspaceId: "ws_1", title: "长历史", origin: "user", status: "active" };
  const agentRun = (index) => {
    const suffix = String(index).padStart(3, "0");
    return {
      id: `agent_run_${suffix}`,
      turnId: `turn_${suffix}`,
      status: "completed",
      createdAt: `2026-07-20T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
      startedAt: "2026-07-20T00:00:00Z",
      completedAt: "2026-07-20T00:00:01Z",
      model: { id: "model_1", displayName: "Clinical" },
      messages: [
        { messageId: `message:turn_${suffix}:user`, role: "user", status: "done", text: `user-${suffix}` },
        { messageId: `message:turn_${suffix}:assistant`, role: "assistant", status: "done", text: `answer-${suffix}` },
      ],
      records: index === 80 ? [
        { type: "tool_call", payload: { callId: "last_read", toolName: "read", toolContractDigest: `sha256:${"a".repeat(64)}`, providerId: "centaeris.builtin", normalizedInput: { path: "history.txt" }, displayTarget: "history.txt" } },
        { type: "tool_result", payload: { callId: "last_read", toolName: "read", resultState: "successWithOutput", modelContent: "Preserved evidence", summary: "read", latencyMs: 1, operations: [] } },
      ] : [],
    };
  };
  let historyRequests = 0;
  await page.route("http://localhost:8000/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "1", email: "member@example.com", isStaff: false } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "默认工作区", status: "active", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", avatarKind: "centaeris", status: "active", deletedAt: null }] } });
    if (path === "/api/models") return route.fulfill({ json: { models: [{ id: "model_1", displayName: "Clinical", provider: "fake", modelName: "fake-model" }] } });
    if (path === "/api/workspaces/ws_1/session-projects") return route.fulfill({ json: { projects: [] } });
    if (path === "/api/workspaces/ws_1/sessions") return route.fulfill({ json: { sessions: [session] } });
    if (path === "/api/sessions/sess_1/assets") return route.fulfill({ json: { assets: [] } });
    if (path === "/api/sessions/sess_1/history") {
      historyRequests += 1;
      const before = url.searchParams.get("before");
      return route.fulfill({
        json: before === null
          ? historyPage(session, Array.from({ length: 40 }, (_, offset) => agentRun(offset + 41)), { nextCursor: "cursor-40", hasMore: true })
          : historyPage(session, Array.from({ length: 40 }, (_, offset) => agentRun(offset + 1))),
      });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/agents/centaeris");
  const list = page.getByTestId("virtual-agent-run-list");
  await expect(page.getByText("user-080", { exact: true })).toBeVisible();
  expect(await list.getByRole("article").count()).toBeLessThan(24);
  const latestRun = page.locator('[data-agent-run-id="agent_run_080"]');
  await latestRun.locator(".workspaceActivityGroup").click();
  await latestRun.getByRole("button", { name: "history.txt", exact: true }).click();
  await expect(latestRun.getByText("Preserved evidence", { exact: true })).toBeVisible();

  await list.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect.poll(() => historyRequests).toBe(2);
  await list.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(page.getByText("user-001", { exact: true })).toBeVisible();
  expect(await list.getByRole("article").count()).toBeLessThan(24);
  await expect(latestRun).toHaveCount(0);
  await page.getByRole("button", { name: "回到最新", exact: true }).click();
  await expect(latestRun.locator(".workspaceActivityGroup")).toHaveAttribute("aria-expanded", "true");
  await expect(latestRun.getByRole("button", { name: "history.txt", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(latestRun.getByText("Preserved evidence", { exact: true })).toBeVisible();
});

test("keeps one live chat through sidebar tabs, settings, history navigation and preference changes", async ({ page }) => {
  const fixture = await installChatFixture(page);
  fixture.setAgentRuns("sess_1", [{
    id: "agent_run_settings", turnId: "turn_1", status: "running", model: { id: "model_1", displayName: "Clinical" },
    createdAt: "2026-08-31T00:00:00Z", startedAt: "2026-08-31T00:00:00Z", completedAt: null,
    messages: [{ messageId: "user_1", role: "user", text: "settings continuity" }],
    records: [
      { type: "phase_event", payload: { stage: "model_process_summary", message: "Persistent body." } },
      { type: "tool_call", payload: { callId: "read_1", toolName: "read", toolContractDigest: `sha256:${"a".repeat(64)}`, providerId: "centaeris.builtin", normalizedInput: { path: "evidence.txt" }, displayTarget: "evidence.txt" } },
      { type: "tool_result", payload: { callId: "read_1", toolName: "read", resultState: "successWithOutput", modelContent: "Preserved evidence", summary: "read", latencyMs: 1, operations: [] } },
    ],
  }]);
  let historyRequests = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/sessions/sess_1/history") historyRequests += 1; });
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    window.__settingsStreamConnections = 0;
    window.__settingsStreamAborts = 0;
    window.fetch = (input, init) => {
      if (!String(input).endsWith("/agent-runs/agent_run_settings/events")) return originalFetch(input, init);
      window.__settingsStreamConnections += 1;
      init?.signal?.addEventListener("abort", () => { window.__settingsStreamAborts += 1; });
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        window.__pushSettingsEvent = (text) => controller.enqueue(new TextEncoder().encode(text));
      } }), { headers: { "Content-Type": "text/event-stream" } }));
    };
  });
  await page.goto("/w/ws_1/agents/centaeris?sessionId=sess_1");
  const run = page.locator('[data-agent-run-id="agent_run_settings"]');
  await run.locator(".workspaceActivityGroup").click();
  await run.getByRole("button", { name: "evidence.txt", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
  await composer.fill("Retained draft");
  await run.evaluate((element) => {
    window.__settingsRun = element;
    window.__settingsBody = element.querySelector(".markdownContent");
    window.__settingsComposer = document.querySelector("#messageDraft");
  });
  const sessionUrl = page.url();
  const historyLength = await page.evaluate(() => history.length);
  for (const name of ["主页", "对话", "主页", "对话"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(sessionUrl);
    await expect(composer).toHaveValue("Retained draft");
    await expect(run.getByRole("button", { name: "evidence.txt", exact: true })).toHaveAttribute("aria-expanded", "true");
    expect(await run.evaluate((element) => ({
      run: element === window.__settingsRun,
      body: element.querySelector(".markdownContent") === window.__settingsBody,
      composer: document.querySelector("#messageDraft") === window.__settingsComposer,
      connections: window.__settingsStreamConnections,
      aborts: window.__settingsStreamAborts,
      historyLength: history.length,
    }))).toEqual({ run: true, body: true, composer: true, connections: 1, aborts: 0, historyLength });
    expect(historyRequests).toBe(1);
  }
  await page.getByRole("button", { name: "默认工作区 工作区菜单" }).click();
  await page.getByRole("link", { name: "设置", exact: true }).click();
  const preferences = page.getByRole("dialog", { name: "偏好", exact: true });
  await expect(preferences).toBeVisible();
  await preferences.getByRole("switch", { name: "使用 Enter 键开始新的一行" }).check();
  await preferences.getByRole("link", { name: "安全", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "安全", exact: true })).toBeVisible();
  await page.goBack();
  await expect(preferences).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(composer).toHaveValue("Retained draft");
  await composer.press("Enter");
  await expect(composer).toHaveValue("Retained draft\n");
  await expect(run.getByRole("button", { name: "evidence.txt", exact: true })).toHaveAttribute("aria-expanded", "true");
  await page.goForward();
  await expect(preferences).toBeVisible();
  const item = committedStreamItem("sess_1", "agent_run_settings", 6, "phase_event", { stage: "model_process_summary", message: "Still streaming behind settings." }, "turn_1");
  await page.evaluate((text) => window.__pushSettingsEvent(text), `id: 6-0\ndata: ${JSON.stringify(item)}\n\n`);
  await expect(run).toContainText("Still streaming behind settings.");
  await preferences.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(composer).toHaveValue("Retained draft\n");
  expect(await run.evaluate((element) => ({
    run: element === window.__settingsRun,
    body: element.querySelector(".markdownContent") === window.__settingsBody,
    composer: document.querySelector("#messageDraft") === window.__settingsComposer,
    connections: window.__settingsStreamConnections,
    aborts: window.__settingsStreamAborts,
  }))).toEqual({ run: true, body: true, composer: true, connections: 1, aborts: 0 });
  expect(historyRequests).toBe(1);
});

for (const path of ["/w/ws_1/app", "/w/ws_1/agents/centaeris?new=1"]) {
test(`sidebar tabs retain an image draft at ${path} until explicit new chat`, async ({ page }) => {
  await installChatFixture(page);
  const writes = [];
  page.on("request", (request) => { if (["POST", "PATCH", "DELETE"].includes(request.method())) writes.push(request.url()); });
  await page.goto(path);
  const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
  await composer.fill("Unsent image draft");
  await page.getByLabel("选择一个或多个材料").setInputFiles({
    name: "sidebar-draft.svg", mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="blue"/></svg>'),
  });
  const thumbnail = page.getByRole("button", { name: "预览 sidebar-draft.svg", exact: true }).locator("img");
  await expect(thumbnail).toBeVisible();
  const source = await thumbnail.getAttribute("src");
  expect(source).toMatch(/^blob:/);
  await thumbnail.evaluate((element) => { window.__sidebarThumbnail = element; window.__sidebarComposer = document.querySelector("#messageDraft"); });
  const draftUrl = page.url();
  const historyLength = await page.evaluate(() => history.length);
  for (const name of ["主页", "对话", "主页", "对话"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(draftUrl);
    await expect(composer).toHaveValue("Unsent image draft");
    await expect(thumbnail).toHaveAttribute("src", source);
    expect(await thumbnail.evaluate((element) => ({
      image: element === window.__sidebarThumbnail,
      composer: document.querySelector("#messageDraft") === window.__sidebarComposer,
      historyLength: history.length,
    }))).toEqual({ image: true, composer: true, historyLength });
  }
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: /^新对话/ }).click();
  await expect(composer).toHaveValue("");
  await expect(page.locator(".workspaceComposerAttachments .attachmentCard")).toHaveCount(0);
  expect(writes).toEqual([]);
});
}

test("redirects a member from Models to the neutral workspace home", async ({ page }) => {
  let createdSessions = 0;
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "test-token" } });
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "user_1", email: "member@example.com", isStaff: false, isSuperuser: false } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "默认工作区", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", avatarKind: "centaeris", status: "active", deletedAt: null }] } });
    if (path === "/api/models") return route.fulfill({ json: { models: [{ id: "model_1", displayName: "Clinical", provider: "fake", modelName: "fake-model" }] } });
    if (path === "/api/workspaces/ws_1/session-projects") return route.fulfill({ json: { projects: [] } });
    if (path === "/api/workspaces/ws_1/sessions" && request.method() === "GET") return route.fulfill({ json: { sessions: [] } });
    if (path === "/api/workspaces/ws_1/sessions" && request.method() === "POST") {
      createdSessions += 1;
      expect(request.postDataJSON()).toEqual({ agentId: "centaeris" });
      return route.fulfill({ status: 201, json: { session: { id: "sess_1", workspaceId: "ws_1", agentId: "centaeris", title: "New chat", origin: "user", status: "active" } } });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/settings/models");
  await expect(page).toHaveURL(/\/settings\/general$/);
  await expect(page.getByRole("heading", { name: "通用" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "输入消息", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("active-session")).toHaveCount(0);
  expect(createdSessions).toBe(0);
});

test("permanently deletes a session after one concise confirmation", async ({ page }) => {
  const fixture = await installChatFixture(page);
  fixture.sessions[0].title = "某市一所公办中学规定：学生在校期间一律不得携带手机";
  await page.goto("/w/ws_1/agents/centaeris");
  const row = page.locator(".workspaceSessionRow").first();
  const sessionButton = row.locator(".workspaceSessionButton");
  const sessionActions = row.locator(".workspaceSessionActions");
  await expect(sessionButton).toHaveCSS("padding-right", "8px");
  await expect(sessionActions).toHaveCSS("opacity", "0");
  await expect(sessionActions.locator(":scope > button")).toHaveCount(1);
  await row.hover();
  await expect(sessionButton).toHaveCSS("padding-right", "34px");
  await expect(sessionActions).toHaveCSS("opacity", "1");

  await page.getByRole("button", { name: "会话操作 某市一所公办中学规定：学生在校期间一律不得携带手机", exact: true }).click();
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确定要删除此对话？", exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(() => fixture.deletedSessionIds).toEqual([]);
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect.poll(() => fixture.deletedSessionIds).toEqual(["sess_1"]);
  await expect(page.getByRole("button", { name: /归档/ })).toHaveCount(0);
});

test("edits session metadata without changing its row height", async ({ page }) => {
  const fixture = await installChatFixture(page);
  await page.goto("/w/ws_1/agents/centaeris");
  const row = page.locator(".workspaceSessionRow").first();
  const rowHeight = (await row.boundingBox()).height;
  await expect(row.locator("small")).toHaveCount(0);
  await page.getByRole("button", { name: "会话操作 New chat", exact: true }).click();
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  await expect(page.locator(".workspaceSessionEdit")).toHaveCount(1);
  expect((await page.locator(".workspaceSessionEdit").boundingBox()).height).toBe(rowHeight);
  const titleInput = page.getByRole("textbox", { name: "重命名 New chat", exact: true });
  await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "取消", exact: true })).toHaveCount(0);
  await titleInput.press("Control+A");
  await titleInput.pressSequentially("输错了");
  await titleInput.press("Control+Z");
  await expect(titleInput).toHaveValue("输错");
  await titleInput.press("Control+Z");
  await expect(titleInput).toHaveValue("输");
  await titleInput.press("Control+Z");
  await expect(titleInput).toHaveValue("New chat");
  await titleInput.press("Control+A");
  await titleInput.pressSequentially("已重命名");
  await titleInput.press("Escape");
  await expect(row).toContainText("已重命名");
  expect((await row.boundingBox()).height).toBe(rowHeight);

  await page.getByRole("button", { name: "会话操作 已重命名", exact: true }).click();
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  await page.getByRole("textbox", { name: "重命名 已重命名", exact: true }).fill("点击空白保存");
  await page.getByText("代理", { exact: true }).click();
  await expect(row).toContainText("点击空白保存");

  await page.getByRole("button", { name: "会话操作 点击空白保存", exact: true }).click();
  await page.getByRole("menuitem", { name: "置顶", exact: true }).click();
  await expect.poll(() => fixture.sessions[0].isPinned).toBe(true);
  await expect(row.getByLabel("已置顶", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "会话操作 点击空白保存", exact: true }).click();
  await page.getByRole("menuitem", { name: "标为未读", exact: true }).click();
  await expect.poll(() => fixture.sessions[0].isUnread).toBe(true);
  await expect(row.getByLabel("未读", { exact: true })).toBeVisible();
});

test("groups pinned, project, and recent sessions and lazily creates project children", async ({ page }) => {
  const fixture = await installChatFixture(page);
  const navigationRequests = { sessions: 0, projects: 0 };
  page.on("request", (request) => {
    if (request.method() !== "GET") return;
    const path = new URL(request.url()).pathname;
    if (path === "/api/workspaces/ws_1/sessions") navigationRequests.sessions += 1;
    if (path === "/api/workspaces/ws_1/session-projects") navigationRequests.projects += 1;
  });
  fixture.sessions[0].title = "顶部置顶";
  fixture.sessions[0].isPinned = true;
  fixture.projects.push({ id: "session_project_1", workspaceId: "ws_1", agentId: "centaeris", name: "Lumi", createdAt: "2026-07-14T00:00:00Z" });
  fixture.sessions.push(
    { id: "sess_2", workspaceId: "ws_1", agentId: "centaeris", projectId: "session_project_1", title: "项目内置顶", origin: "user", status: "active", isPinned: true, isUnread: false, updatedAt: "2026-07-13T00:00:00Z" },
    { id: "sess_3", workspaceId: "ws_1", agentId: "centaeris", projectId: null, title: "自动化最近", origin: "automation", status: "active", isPinned: false, isUnread: false, updatedAt: "2026-07-12T00:00:00Z" },
  );

  await page.goto("/w/ws_1/agents/centaeris");

  const pinned = page.getByRole("navigation", { name: "置顶会话" });
  const project = page.getByRole("navigation", { name: "Lumi 会话" });
  const recent = page.getByRole("navigation", { name: "最近会话" });
  await expect(pinned.getByText("顶部置顶", { exact: true })).toBeVisible();
  await expect(pinned.getByText("项目内置顶", { exact: true })).toHaveCount(0);
  await expect(pinned.locator(".workspaceSessionKindIcon")).toHaveCount(1);
  await expect(project.getByText("项目内置顶", { exact: true })).toBeVisible();
  await expect(project.getByLabel("已置顶", { exact: true })).toBeVisible();
  await expect(recent.getByText("自动化最近", { exact: true })).toBeVisible();
  await expect(recent.getByText("自动", { exact: true })).toBeVisible();

  const sessionSections = page.locator(".shSessionSection");
  const pinnedHeader = sessionSections.nth(0).locator(".shDisclosureSummary");
  const projectHeader = sessionSections.nth(1).locator(".shDisclosureSummary");
  const projectAdd = page.getByRole("button", { name: "创建项目", exact: true });
  const projectRow = sessionSections.nth(1).locator(".shProject").first();
  const projectChevron = projectRow.locator(".shProjectSummary > svg").first();
  for (const header of [pinnedHeader, projectHeader, sessionSections.nth(2).locator(".shDisclosureSummary")]) {
    await expect(header).toHaveCSS("font-size", "11px");
    await expect(header).toHaveCSS("height", "24px");
  }
  for (const action of await page.locator(".shSectionAction, .shProjectAction").all()) {
    const buttonBox = await action.boundingBox();
    const iconBox = await action.locator("svg").boundingBox();
    expect(Math.abs(iconBox.x + iconBox.width / 2 - buttonBox.x - buttonBox.width / 2)).toBeLessThan(0.1);
    expect(Math.abs(iconBox.y + iconBox.height / 2 - buttonBox.y - buttonBox.height / 2)).toBeLessThan(0.1);
  }
  await expect(projectHeader.locator("svg")).toHaveCSS("opacity", "0");
  await expect(projectChevron).toHaveCSS("opacity", "0");
  await expect(projectAdd).toHaveCSS("opacity", "0");
  await expect(sessionSections.nth(1)).toHaveCSS("margin-top", "16px");
  await sessionSections.nth(1).hover();
  await expect(projectHeader.locator("svg")).toHaveCSS("opacity", "1");
  await expect(projectAdd).toHaveCSS("opacity", "1");
  const projectHeaderBox = await projectHeader.boundingBox();
  const projectAddBox = await projectAdd.boundingBox();
  expect(Math.abs((projectHeaderBox.y + projectHeaderBox.height / 2) - (projectAddBox.y + projectAddBox.height / 2))).toBeLessThanOrEqual(1);

  await projectRow.hover();
  await expect(projectChevron).toHaveCSS("opacity", "1");

  await projectAdd.click();
  const dialog = page.getByRole("dialog", { name: "创建项目", exact: true });
  const projectDialogBox = await dialog.boundingBox();
  const projectCloseBox = await dialog.getByRole("button", { name: "关闭创建项目", exact: true }).boundingBox();
  const projectHeadingBox = await dialog.getByRole("heading", { name: "创建项目", exact: true }).boundingBox();
  expect(projectCloseBox.x).toBeLessThan(projectHeadingBox.x);
  expect(projectCloseBox.x - projectDialogBox.x).toBeLessThanOrEqual(12);
  expect(projectCloseBox.y - projectDialogBox.y).toBeLessThanOrEqual(12);
  expect(projectDialogBox.width).toBeLessThanOrEqual(380);
  await expect(dialog.locator(".shProjectNameField")).toHaveCount(0);
  const projectNameInput = dialog.getByRole("textbox", { name: "项目名称", exact: true });
  await expect(projectNameInput).toHaveCSS("outline-style", "none");
  await projectNameInput.fill("新项目");
  await dialog.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(page.getByText("新项目", { exact: true })).toBeVisible();

  const sessionCount = fixture.sessions.length;
  await page.getByRole("button", { name: "在 新项目 中新建会话", exact: true }).click();
  await expect(page).toHaveURL(/new=1.*projectId=session_project_2/);
  await expect.poll(() => navigationRequests).toEqual({ sessions: 2, projects: 2 });
  expect(fixture.sessions).toHaveLength(sessionCount);
  const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
  await composer.fill("不应带进另一个项目");
  await page.getByRole("button", { name: "在 Lumi 中新建会话", exact: true }).click();
  await expect(page).toHaveURL(/new=1.*projectId=session_project_1/);
  await expect(composer).toHaveValue("");
  await expect.poll(() => navigationRequests).toEqual({ sessions: 3, projects: 3 });
  await composer.fill("仍不应带进新项目");
  await page.getByRole("button", { name: "在 新项目 中新建会话", exact: true }).click();
  await expect(page).toHaveURL(/new=1.*projectId=session_project_2/);
  await expect(composer).toHaveValue("");
  await expect.poll(() => navigationRequests).toEqual({ sessions: 4, projects: 4 });
  await composer.fill("项目中的新会话");
  await composer.press("Enter");
  await expect.poll(() => fixture.messageBody?.projectId).toBe("session_project_2");
  await expect(page.getByRole("navigation", { name: "新项目 会话" }).getByText("项目中的新会话", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "新建一般会话", exact: true }).click();
  await expect(page).toHaveURL(/new=1$/);
});

test("clears a deleted transcript before the next session history resolves", async ({ page }) => {
  const sessions = [
    { id: "sess_1", workspaceId: "ws_1", title: "旧会话", origin: "user", status: "active", isPinned: false, isUnread: false, updatedAt: "2026-07-14T00:00:00Z" },
    { id: "sess_2", workspaceId: "ws_1", title: "新会话", origin: "user", status: "active", isPinned: false, isUnread: false, updatedAt: "2026-07-13T00:00:00Z" },
  ];
  let releaseNextHistory;
  const nextHistory = new Promise((resolve) => { releaseNextHistory = resolve; });
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "test-token" } });
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "user_1", email: "member@example.com", isStaff: false } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "默认工作区", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", avatarKind: "centaeris", status: "active", deletedAt: null }] } });
    if (path === "/api/models") return route.fulfill({ json: { models: [{ id: "model_1", displayName: "Clinical", provider: "fake", modelName: "fake-model" }] } });
    if (path === "/api/workspaces/ws_1/session-projects") return route.fulfill({ json: { projects: [] } });
    if (path === "/api/workspaces/ws_1/sessions") return route.fulfill({ json: { sessions } });
    if (path === "/api/sessions/sess_1/assets" || path === "/api/sessions/sess_2/assets") return route.fulfill({ json: { assets: [] } });
    if (path === "/api/sessions/sess_1/history") return route.fulfill({ json: historyPage(sessions[0], [{ id: "agent_run_1", turnId: "turn_1", status: "completed", createdAt: "2026-07-14T00:00:00Z", startedAt: "2026-07-14T00:00:00Z", completedAt: "2026-07-14T00:00:01Z", model: { id: "model_1", displayName: "Clinical" }, messages: [{ messageId: "user_1", role: "user", status: "done", text: "旧问题" }, { messageId: "assistant_1", role: "assistant", status: "done", text: "旧回答" }] }]) });
    if (path === "/api/sessions/sess_2/history") {
      await nextHistory;
      return route.fulfill({ json: historyPage(sessions[1], [{ id: "agent_run_2", turnId: "turn_2", status: "completed", createdAt: "2026-07-13T00:00:00Z", startedAt: "2026-07-13T00:00:00Z", completedAt: "2026-07-13T00:00:01Z", model: { id: "model_1", displayName: "Clinical" }, messages: [{ messageId: "user_2", role: "user", status: "done", text: "新问题" }, { messageId: "assistant_2", role: "assistant", status: "done", text: "新回答" }] }]) });
    }
    if (path === "/api/sessions/sess_1" && request.method() === "DELETE") return route.fulfill({ json: { deleted: true } });
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/agents/centaeris");
  await expect(page.getByText("旧回答", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "会话操作 旧会话", exact: true }).click();
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await page.getByRole("dialog", { name: "确定要删除此对话？", exact: true }).getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByText("旧回答", { exact: true })).toHaveCount(0);
  await expect(page.getByText("正在读取会话…", { exact: true })).toBeVisible();
  releaseNextHistory();
  await expect(page.getByText("新回答", { exact: true })).toBeVisible();
});

test("uses the URL workspace when the user has multiple memberships", async ({ page }) => {
  await page.route("http://localhost:8000/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "test-token" } });
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "user_1", email: "member@example.com", isStaff: false } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "一", role: "owner" }, { id: "ws_2", name: "二", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", avatarKind: "centaeris", status: "active", deletedAt: null }] } });
    if (path === "/api/models") return route.fulfill({ json: { models: [] } });
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/agents/centaeris");
  const modelPicker = page.getByRole("button", { name: "AI 模型", exact: true });
  await expect(modelPicker).toBeDisabled();
  await expect(modelPicker).toHaveText("未配置");
  await expect(page.getByRole("textbox", { name: "输入消息", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "输入", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "一 工作区菜单" }).click();
  const switcher = page.getByRole("group", { name: "切换工作区" });
  await expect(switcher.locator("[aria-current=page]")).toContainText("一");
  await expect(switcher.getByRole("link", { name: "二" })).toBeVisible();
});

test("keeps user and automation origins visible in recent sessions", async ({ page }) => {
  const sessions = [
    { id: "sess_user", workspaceId: "ws_1", title: "普通对话", origin: "user", status: "active" },
    { id: "sess_automation", workspaceId: "ws_1", title: "每日资料检查", origin: "automation", status: "active" },
  ];
  await page.route("http://localhost:8000/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "test-token" } });
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "user_1", email: "member@example.com", isStaff: false } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "默认工作区", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", avatarKind: "centaeris", status: "active", deletedAt: null }] } });
    if (path === "/api/models") return route.fulfill({ json: { models: [{ id: "model_1", displayName: "Clinical", provider: "fake", modelName: "fake-model" }] } });
    if (path === "/api/workspaces/ws_1/session-projects") return route.fulfill({ json: { projects: [] } });
    if (path === "/api/workspaces/ws_1/sessions") return route.fulfill({ json: { sessions } });
    const historyMatch = path.match(/^\/api\/sessions\/(sess_[^/]+)\/history$/);
    if (historyMatch) {
      const session = sessions.find((item) => item.id === historyMatch[1]);
      return route.fulfill({ json: historyPage(session, []) });
    }
    if (/^\/api\/sessions\/sess_[^/]+\/assets$/.test(path)) return route.fulfill({ json: { assets: [] } });
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/agents/centaeris");

  const recent = page.getByRole("navigation", { name: "最近会话" });
  await expect(recent.getByText("普通对话", { exact: true })).toBeVisible();
  await expect(recent.getByText("每日资料检查", { exact: true })).toBeVisible();
  await expect(recent.getByText("自动", { exact: true })).toBeVisible();
});

test("marks the initially selected unread session exactly once across unrelated rerenders", async ({ page }) => {
  const fixture = await installChatFixture(page);
  fixture.sessions[0].isUnread = true;
  const readPatches = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && new URL(request.url()).pathname === "/api/sessions/sess_1") {
      readPatches.push(request.postDataJSON());
    }
  });

  await page.goto("/w/ws_1/agents/centaeris?sessionId=sess_1");
  await expect.poll(() => readPatches).toEqual([{ isUnread: false }]);
  await page.getByRole("tab", { name: "主页", exact: true }).click();
  await page.getByRole("tab", { name: "对话", exact: true }).click();
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.waitForTimeout(100);
  expect(readPatches).toEqual([{ isUnread: false }]);
});

test("keeps reconnecting until durable terminal history arrives", async ({ page }) => {
  let streamAttempt = 0;
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "test-token" } });
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "1", email: "member@example.com", isStaff: false } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "默认工作区", status: "active", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", avatarKind: "centaeris", status: "active", deletedAt: null }] } });
    if (path === "/api/models") return route.fulfill({ json: { models: [{ id: "model_1", displayName: "Clinical", provider: "fake", modelName: "fake-model" }] } });
    if (path === "/api/workspaces/ws_1/session-projects") return route.fulfill({ json: { projects: [] } });
    if (path === "/api/workspaces/ws_1/sessions") return route.fulfill({ json: { sessions: [{ id: "sess_1", workspaceId: "ws_1", title: "New chat", origin: "user", status: "active" }] } });
    if (path === "/api/sessions/sess_1/assets") return route.fulfill({ json: { assets: [] } });
    if (path === "/api/sessions/sess_1/history") {
      return route.fulfill({ json: historyPage({ id: "sess_1", workspaceId: "ws_1", title: "New chat", origin: "user", status: "active" }, []) });
    }
    if (path === "/api/workspaces/ws_1/sessions/sess_1/messages") return route.fulfill({ status: 202, json: { agentRunId: "agent_run_1", turnId: "turn_1", sessionId: "sess_1", session: { id: "sess_1", workspaceId: "ws_1", agentId: "centaeris", title: "断线恢复", origin: "user", status: "active" }, status: "accepted" } });
    if (path === "/api/sessions/sess_1/agent-runs/agent_run_1/events") {
      streamAttempt += 1;
      if (streamAttempt === 1) {
        return route.fulfill({
          contentType: "text/event-stream",
          body: sse([liveStreamItem("agent_run_1", 1, "已经生成", "turn_1")]),
        });
      }
      if (streamAttempt < 5) return route.fulfill({ contentType: "text/event-stream", body: ": keepalive\n\n" });
      expect(request.headers()["last-event-id"]).toBe("1-0");
      return route.fulfill({
        contentType: "text/event-stream",
        body: sse([
          committedStreamItem("sess_1", "agent_run_1", 3, "assistant_message", { messageId: "message:turn_1:assistant", modelMarkdown: "已经生成完整回答", artifactRefs: [], status: "done" }, "turn_1"),
          committedStreamItem("sess_1", "agent_run_1", 4, "agent_run_completed", { doneReason: "finalized" }, "turn_1"),
        ]),
      });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/agents/centaeris");
  await expect(page.getByRole("button", { name: "AI 模型", exact: true })).toHaveText("Clinical");
  await page.getByRole("textbox", { name: "输入消息", exact: true }).fill("断线恢复");
  await page.getByRole("textbox", { name: "输入消息", exact: true }).press("Enter");
  await expect(page.getByText("已经生成完整回答", { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(streamAttempt).toBe(5);
  await expect(page.locator(".errorBanner")).toHaveCount(0);
});

test("reopens an active AgentRun from its history stream cursor", async ({ page }) => {
  let releaseFinal;
  const finalGate = new Promise((resolve) => { releaseFinal = resolve; });
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "test-token" } });
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "1", email: "member@example.com", isStaff: false } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "默认工作区", status: "active", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", avatarKind: "centaeris", status: "active", deletedAt: null }] } });
    if (path === "/api/models") return route.fulfill({ json: { models: [{ id: "model_1", displayName: "Clinical", provider: "fake", modelName: "fake-model" }] } });
    if (path === "/api/workspaces/ws_1/session-projects") return route.fulfill({ json: { projects: [] } });
    if (path === "/api/workspaces/ws_1/sessions") return route.fulfill({ json: { sessions: [{ id: "sess_1", workspaceId: "ws_1", title: "每日资料检查", origin: "automation", status: "active" }] } });
    if (path === "/api/sessions/sess_1/assets") return route.fulfill({ json: { assets: [] } });
    if (path === "/api/sessions/sess_1/history") {
      const session = { id: "sess_1", workspaceId: "ws_1", title: "每日资料检查", origin: "automation", status: "active" };
      return route.fulfill({ json: historyPage(session, [{
          id: "agent_run_1",
          turnId: "turn_1",
          status: "running",
          createdAt: "2026-07-20T00:00:00Z",
          startedAt: "2026-07-20T00:00:01Z",
          completedAt: null,
          model: { id: "model_1", displayName: "Clinical" },
          messages: [{ messageId: "message:turn_1:user", role: "user", status: "done", text: "检查工作区资料" }],
          records: [{
            type: "tool_call",
            payload: { callId: "call_read", toolName: "read", toolContractDigest: `sha256:${"a".repeat(64)}`, providerId: "centaeris.builtin", normalizedInput: { path: "." }, displayTarget: "授权资料" },
          }],
          live: { messageId: "message:turn_1:assistant", text: "我会核对当前授权资料。" },
          streamCursor: "5002-0",
        }]) });
    }
    if (path === "/api/sessions/sess_1/agent-runs/agent_run_1/events") {
      expect(request.headers()["last-event-id"]).toBe("5002-0");
      await finalGate;
      return route.fulfill({
        contentType: "text/event-stream",
        body: sse([
          committedStreamItem("sess_1", "agent_run_1", 4, "assistant_message", { messageId: "message:turn_1:2:assistant", modelMarkdown: "工作区资料检查完成", artifactRefs: [], status: "done" }, "turn_1:2"),
          committedStreamItem("sess_1", "agent_run_1", 5, "agent_run_completed", { doneReason: "finalized" }, "turn_1:2"),
        ]),
      });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/agents/centaeris?sessionId=sess_1");
  const currentRun = page.locator('[data-agent-run-id="agent_run_1"]');
  const liveGroup = currentRun.locator(".workspaceActivityGroup");
  await expect(liveGroup).toHaveText("Read files");
  await expect(currentRun.getByText("Reading 授权资料", { exact: true })).toHaveCount(1);
  await expect(currentRun.locator(".workspaceLiveStatusText")).toHaveText("Reading 授权资料");
  await liveGroup.click();
  await expect(currentRun.locator(".workspaceActivityDetails.isExpanded")).toContainText(".");
  releaseFinal();
  await expect(page.getByText("工作区资料检查完成", { exact: true })).toBeVisible();
  await expect(page.getByText("Reconnecting", { exact: true })).toHaveCount(0);
});

test("reloads history after an expired stream cursor", async ({ page }) => {
  let historyAttempt = 0;
  let eventAttempt = 0;
  await page.route("http://localhost:8000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/csrf") return route.fulfill({ json: { csrfToken: "test-token" } });
    if (path === "/api/me") return route.fulfill({ json: { user: { id: "1", email: "member@example.com", isStaff: false } } });
    if (path === "/api/workspaces") return route.fulfill({ json: { workspaces: [{ id: "ws_1", name: "默认工作区", status: "active", role: "owner" }] } });
    if (path === "/api/workspaces/ws_1/agents") return route.fulfill({ json: { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", avatarKind: "centaeris", status: "active", deletedAt: null }] } });
    if (path === "/api/models") return route.fulfill({ json: { models: [{ id: "model_1", displayName: "Clinical", provider: "fake", modelName: "fake-model" }] } });
    if (path === "/api/workspaces/ws_1/session-projects") return route.fulfill({ json: { projects: [] } });
    if (path === "/api/workspaces/ws_1/sessions") return route.fulfill({ json: { sessions: [{ id: "sess_1", workspaceId: "ws_1", title: "游标恢复", origin: "user", status: "active" }] } });
    if (path === "/api/sessions/sess_1/assets") return route.fulfill({ json: { assets: [] } });
    if (path === "/api/sessions/sess_1/history") {
      historyAttempt += 1;
      const session = { id: "sess_1", workspaceId: "ws_1", title: "游标恢复", origin: "user", status: "active" };
      const agentRuns = historyAttempt === 1 ? [] : [{
        id: "agent_run_1", turnId: "turn_1", status: "running", createdAt: "2026-07-20T00:00:00Z", startedAt: "2026-07-20T00:00:01Z", completedAt: null,
        model: { id: "model_1", displayName: "Clinical" },
        messages: [{ messageId: "message:turn_1:user", role: "user", status: "done", text: "测试游标恢复" }],
        streamCursor: "9-0",
      }];
      return route.fulfill({ json: historyPage(session, agentRuns) });
    }
    if (path === "/api/workspaces/ws_1/sessions/sess_1/messages") return route.fulfill({ status: 202, json: { agentRunId: "agent_run_1", turnId: "turn_1", sessionId: "sess_1", session: { id: "sess_1", workspaceId: "ws_1", agentId: "centaeris", title: "游标恢复", origin: "user", status: "active" }, status: "accepted" } });
    if (path === "/api/sessions/sess_1/agent-runs/agent_run_1/events") {
      eventAttempt += 1;
      if (eventAttempt === 1) return route.fulfill({ status: 409, json: { error: "agent_run_event_cursor_expired" } });
      expect(request.headers()["last-event-id"]).toBe("9-0");
      return route.fulfill({ contentType: "text/event-stream", body: sse([
        committedStreamItem("sess_1", "agent_run_1", 3, "assistant_message", { messageId: "message:turn_1:assistant", modelMarkdown: "恢复完成", artifactRefs: [], status: "done" }, "turn_1"),
        committedStreamItem("sess_1", "agent_run_1", 4, "agent_run_completed", { doneReason: "finalized" }, "turn_1"),
      ]) });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/agents/centaeris");
  await expect.poll(() => historyAttempt).toBe(1);
  const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
  await composer.fill("测试游标恢复");
  await composer.press("Enter");
  await expect(page.getByText("恢复完成", { exact: true })).toBeVisible();
  expect(eventAttempt).toBe(2);
});

test("keeps tool evidence inline and opens one resizable reference preview", async ({ page }) => {
  await page.addInitScript(() => {
    const nativeAddEventListener = EventTarget.prototype.addEventListener;
    const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;
    window.__windowKeydownSubscriptions = { adds: 0, removes: 0 };
    EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
      if (this === window && type === "keydown") window.__windowKeydownSubscriptions.adds += 1;
      return nativeAddEventListener.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function removeEventListener(type, listener, options) {
      if (this === window && type === "keydown") window.__windowKeydownSubscriptions.removes += 1;
      return nativeRemoveEventListener.call(this, type, listener, options);
    };
  });
  await page.route("http://localhost:8000/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const records = [
      { type: "tool_call", payload: { callId: "call_bash", toolName: "bash", toolContractDigest: `sha256:${"b".repeat(64)}`, providerId: "centaeris.builtin", normalizedInput: { command: "python -c \"print('ok')\"" }, displayTarget: "受控命令" } },
      { type: "tool_result", payload: { callId: "call_bash", toolName: "bash", resultState: "successWithOutput", modelContent: "ok", summary: "命令已完成", latencyMs: 1, operations: [{ callId: "call_bash", toolName: "bash", kind: "command", status: "ok", resultState: "successWithOutput", outputPreview: "ok", exitCode: 0 }] } },
      { type: "tool_call", payload: { callId: "call_edit", toolName: "edit", toolContractDigest: `sha256:${"e".repeat(64)}`, providerId: "centaeris.builtin", normalizedInput: { path: "notes.txt", old_text: "missing", new_text: "new" }, displayTarget: "notes.txt" } },
      { type: "tool_result", payload: { callId: "call_edit", toolName: "edit", resultState: "failed", modelContent: "FAKE DIFF", summary: "summary only", latencyMs: 1, operations: [{ callId: "call_edit", toolName: "edit", status: "error", resultState: "failed", path: "notes.txt", error: "replacement not found" }] } },
      { type: "citation_recorded", payload: { citationId: "citation_timeline", inputRef: "input_1", displayName: "术前须知.md", evidenceKind: "workspaceSource" } },
      { type: "citation_recorded", payload: { citationId: "citation_timeline_2", inputRef: "input_1", displayName: "术前须知.md", evidenceKind: "workspaceSource" } },
    ];
    if (path === "/api/citations/citation_timeline/preview") {
      return route.fulfill({ contentType: "text/markdown", body: "标题\n必须核对患者病史。\n完成术前确认。" });
    }
    const responses = {
      "/api/me": { user: { id: "1", email: "member@example.com", isStaff: false } },
      "/api/workspaces": { workspaces: [{ id: "ws_1", name: "默认工作区", status: "active", role: "owner" }] },
      "/api/workspaces/ws_1/agents": { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", avatarKind: "centaeris", status: "active", deletedAt: null }] },
      "/api/models": { models: [{ id: "model_1", displayName: "Clinical", provider: "fake", modelName: "fake-model" }] },
      "/api/workspaces/ws_1/session-projects": { projects: [] },
      "/api/workspaces/ws_1/sessions": { sessions: [{ id: "sess_1", workspaceId: "ws_1", title: "术前提醒", origin: "user", status: "active" }] },
      "/api/sessions/sess_1/assets": { assets: [] },
      "/api/sessions/sess_1/history": historyPage({ id: "sess_1", workspaceId: "ws_1", title: "术前提醒", origin: "user", status: "active" }, [{ id: "agent_run_1", turnId: "turn_1", status: "completed", createdAt: "2026-07-14T00:00:00Z", startedAt: "2026-07-14T00:00:01Z", completedAt: "2026-07-14T01:02:04Z", model: { id: "model_1", displayName: "Clinical" }, messages: [{ messageId: "user_1", role: "user", status: "done", text: "查找术前资料" }, { messageId: "assistant_stage", turnId: "turn_1", role: "assistant", phase: "stage", status: "done", text: "我会先核对正式资料，再确认术前要求。" }, { messageId: "assistant_1", turnId: "turn_1:2", role: "assistant", phase: "final", status: "done", text: "已找到。" }], records }]),
      "/api/citations/citation_timeline": { citation: { citationId: "citation_timeline", inputRef: "input_1", displayName: "术前须知.md", evidenceKind: "workspaceSource", locator: { startLine: 2, endLine: 2 }, sourceUrl: "/api/citations/citation_timeline", previewUrl: "/api/citations/citation_timeline/preview" } },
    };
    const response = responses[path];
    return response ? route.fulfill({ json: response }) : route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/agents/centaeris");
  const references = page.getByRole("region", { name: "引用", exact: true });
  await expect(references.getByRole("button", { name: /术前须知\.md 引用/ })).toHaveCount(1);
  await expect(page.getByText("我会先核对正式资料，再确认术前要求。", { exact: true })).toBeVisible();
  await expect(page.getByText(/Worked(?: for)?/, { exact: true })).toHaveCount(0);
  const toolGroup = page.getByRole("button", { name: "Ran commands · Edited files", exact: true });
  await expect(toolGroup).toBeVisible();
  await expect(toolGroup.locator(".workspaceActivityGroupIcon")).toHaveCount(1);
  await expect(toolGroup.locator("span")).toHaveCSS("text-decoration-line", "none");
  await expect(page.getByRole("complementary", { name: "活动", exact: true })).toHaveCount(0);
  await expect(page.locator(".workspaceActivityDetails")).toHaveCount(0);
  await toolGroup.click();
  const details = page.locator(".workspaceActivityDetails");
  await expect(details.locator(".activityOperationDisclosure")).toHaveCount(0);
  await details.getByRole("button", { name: /python -c/ }).click();
  await expect(details.locator(".activityOperationDisclosure.isExpanded")).toContainText("$ python -c \"print('ok')\"");
  await expect(details).toContainText("Exit 0");
  await details.getByRole("button", { name: /notes\.txt/ }).click();
  await expect(details.locator(".activityOperation.is-edit .activityOperationDisclosure.isExpanded")).toContainText("replacement not found");
  await expect(details).not.toContainText("FAKE DIFF");
  await expect(details).not.toContainText("summary only");
  const keydownBeforePreview = await page.evaluate(() => ({ ...window.__windowKeydownSubscriptions }));
  await references.getByRole("button", { name: /术前须知\.md 引用/ }).click();
  const preview = page.getByRole("complementary", { name: "文件预览", exact: true });
  await expect(preview.getByRole("navigation", { name: "文件预览路径" })).toContainText("库");
  await expect(preview.getByText("必须核对患者病史。", { exact: true })).toBeVisible();
  await expect(preview).toHaveCSS("width", "760px");
  expect(await page.evaluate(() => ({ ...window.__windowKeydownSubscriptions }))).toEqual({
    adds: keydownBeforePreview.adds + 1,
    removes: keydownBeforePreview.removes,
  });
  await preview.getByRole("separator", { name: "调整浏览栏宽度" }).press("ArrowLeft");
  await expect(preview).toHaveCSS("width", "776px");
  expect(await page.evaluate(() => ({ ...window.__windowKeydownSubscriptions }))).toEqual({
    adds: keydownBeforePreview.adds + 1,
    removes: keydownBeforePreview.removes,
  });
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  expect(await page.evaluate(() => ({ ...window.__windowKeydownSubscriptions }))).toEqual({
    adds: keydownBeforePreview.adds + 1,
    removes: keydownBeforePreview.removes + 1,
  });
  await references.getByRole("button", { name: /术前须知\.md 引用/ }).click();
  await expect(preview).toBeVisible();
  await preview.getByRole("button", { name: "库", exact: true }).click();
  await expect(preview).toBeHidden();
});

test("shows historical attachments as named image and file records", async ({ page }) => {
  const session = { id: "sess_1", workspaceId: "ws_1", title: "附件检查", origin: "user", status: "active" };
  const assets = [
    { id: "input_pdf", assetKind: "userLibraryObject", displayName: "术前须知.pdf", contentType: "application/pdf", asset: { id: "library_pdf" } },
    { id: "input_image", assetKind: "userLibraryObject", displayName: "牙片.png", contentType: "image/png", asset: { id: "library_image" } },
  ];
  await page.route("http://localhost:8000/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/library/library_image/preview") {
      return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") });
    }
    if (path === "/api/library/library_pdf/preview") return route.fulfill({ contentType: "application/pdf", body: "%PDF-1.7\n%%EOF\n" });
    const responses = {
      "/api/me": { user: { id: "1", email: "member@example.com", isStaff: false } },
      "/api/workspaces": { workspaces: [{ id: "ws_1", name: "默认工作区", status: "active", role: "owner" }] },
      "/api/workspaces/ws_1/agents": { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", avatarKind: "centaeris", status: "active", deletedAt: null }] },
      "/api/models": { models: [{ id: "model_1", displayName: "Clinical", provider: "fake", modelName: "fake-model" }] },
      "/api/workspaces/ws_1/session-projects": { projects: [] },
      "/api/workspaces/ws_1/sessions": { sessions: [session] },
      "/api/sessions/sess_1/assets": { assets },
      "/api/sessions/sess_1/history": historyPage(session, [{
        id: "agent_run_1",
        turnId: "turn_1",
        status: "completed",
        createdAt: "2026-07-14T00:00:00Z",
        startedAt: "2026-07-14T00:00:00Z",
        completedAt: "2026-07-14T00:00:02Z",
        model: { id: "model_1", displayName: "Clinical" },
        messages: [
          { messageId: "user_1", role: "user", status: "done", text: "查看附件", attachments: [
            { inputRef: "input_pdf", displayName: "术前须知.pdf", contentType: "application/pdf" },
            { inputRef: "input_image", displayName: "牙片.png", contentType: "image/png" },
            { inputRef: "input_missing", displayName: "已移除.txt", contentType: "text/plain" },
          ] },
          { messageId: "assistant_1", role: "assistant", status: "done", text: "已查看。" },
        ],
      }]),
    };
    const response = responses[path];
    return response ? route.fulfill({ json: response }) : route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/agents/centaeris");
  await expect(page.getByText("术前须知.pdf", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "预览 牙片.png", exact: true })).toHaveAttribute("title", "牙片.png");
  await expect(page.getByText("已移除.txt", { exact: true })).toBeVisible();
  await expect(page.getByText("不可用", { exact: true })).toBeVisible();
  await expect(page.locator(".workspaceMessageAttachment.isFile")).toHaveCount(2);
  await expect(page.locator(".workspaceMessageAttachment.isImage img")).toHaveCount(1);
  await expect(page.locator(".workspaceMessageAttachment").first()).toHaveCSS("width", "84px");
  await expect(page.locator(".workspaceMessageAttachment").first()).toHaveCSS("height", "84px");
  await expect(page.locator(".workspaceMessageAttachments .attachmentCardRemove")).toHaveCount(0);
  await page.getByRole("button", { name: "预览 术前须知.pdf", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "预览 术前须知.pdf", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("keeps first-message attachments available in a new-chat draft on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("http://localhost:8000/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses = {
      "/api/me": { user: { id: "1", email: "admin@example.com", isStaff: true, isSuperuser: true } },
      "/api/workspaces": { workspaces: [{ id: "ws_1", name: "默认工作区", description: "", status: "active", role: "owner" }] },
      "/api/workspaces/ws_1/agents": { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", avatarKind: "centaeris", status: "active", deletedAt: null }] },
      "/api/models": { models: [{ id: "model_1", displayName: "Clinical", provider: "fake", modelName: "fake-model" }] },
      "/api/workspaces/ws_1/session-projects": { projects: [] },
      "/api/workspaces/ws_1/sessions": { sessions: [] },
    };
    const response = responses[path];
    return response ? route.fulfill({ json: response }) : route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.goto("/w/ws_1/agents/centaeris");
  await expect(page.getByRole("button", { name: "添加", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "添加", exact: true })).toBeEnabled();
  await expect(page.getByRole("complementary", { name: "资料选择器", exact: true })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "会话导航", exact: true })).toHaveCSS("height", "91px");
  await expect(page.getByRole("complementary", { name: "会话导航", exact: true })).toContainText("默认工作区");
  await expect(page.getByRole("tab", { name: "主页", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "对话", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "搜索会话和笔记", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "输入消息", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("uses the Centaeris information architecture", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route("http://localhost:8000/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses = {
      "/api/me": { user: { id: "1", email: "admin@example.com", isStaff: true, isSuperuser: true } },
      "/api/workspaces": { workspaces: [{ id: "ws_1", name: "默认工作区", description: "", status: "active", role: "owner" }] },
      "/api/workspaces/ws_1/agents": { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", avatarKind: "centaeris", status: "active", deletedAt: null }] },
      "/api/models": { models: [{ id: "model_1", displayName: "Clinical", provider: "fake", modelName: "fake-model" }] },
      "/api/workspaces/ws_1/session-projects": { projects: [] },
      "/api/workspaces/ws_1/sessions": { sessions: [{ id: "sess_1", workspaceId: "ws_1", title: "术前提醒", origin: "user", status: "active", updatedAt: "2026-07-12T00:00:00Z" }] },
      "/api/sessions/sess_1/assets": { assets: [] },
      "/api/sessions/sess_1/history": historyPage({ id: "sess_1", workspaceId: "ws_1", title: "术前提醒", origin: "user", status: "active", updatedAt: "2026-07-12T00:00:00Z" }, []),
    };
    const response = responses[path];
    return response ? route.fulfill({ json: response }) : route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.goto("/w/ws_1/agents/centaeris");
  await expect(page.getByText("附件仅在当前会话中有效", { exact: true })).toHaveCount(0);
  const modelSelect = page.getByRole("button", { name: "AI 模型", exact: true });
  await expect(page.getByRole("img", { name: "设置，待接入", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "思考力度", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "思考力度", exact: true })).toBeDisabled();
  await expect(modelSelect).toHaveCSS("border-top-width", "0px");
  await expect(modelSelect).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const sidebar = page.getByRole("complementary", { name: "会话导航", exact: true });
  await expect(sidebar).toHaveCSS("width", "270px");
  await expect(sidebar).toHaveCSS("background-color", "rgb(247, 247, 245)");
  await expect(page.getByRole("button", { name: "新建一般会话", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "主页", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "对话", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "当前会话", exact: true })).toContainText("Centaeris/术前提醒");
  const leftSidebarToggle = page.getByRole("button", { name: "隐藏左侧栏", exact: true });
  await expect(leftSidebarToggle).toBeVisible();
  await expect(page.getByRole("button", { name: /右侧栏/ })).toHaveCount(0);
  await leftSidebarToggle.click();
  await expect(page.locator(".workspaceSidebarSlot")).toHaveCSS("width", "0px");
  const showSidebar = page.getByRole("button", { name: "显示左侧栏", exact: true });
  await expect(showSidebar).toHaveCSS("border-right-width", "0px");
  await expect(page.locator(".workspaceTopbar")).toHaveCSS("border-bottom-width", "0px");
  await expect(page.getByRole("navigation", { name: "当前会话", exact: true })).toHaveCount(0);
  await showSidebar.click();
  await expect(page.getByRole("navigation", { name: "当前会话", exact: true })).toBeVisible();
  await expect(page.locator(".workspaceSidebarSlot")).toHaveCSS("width", "270px");
  await expect(page.getByRole("tab", { name: "对话", exact: true })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "输入消息", exact: true }).locator("..");
  expect((await composer.boundingBox())?.width).toBeLessThanOrEqual(820);
  await expect(page.locator(".workspaceChatColumn")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  if (process.platform === "win32") {
    await expect(page).toHaveScreenshot("workspace-centaeris-visual.png", {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.01,
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sidebar).toHaveCSS("height", "91px");
  await expect(page.getByRole("tab", { name: "对话", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "输入消息", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "隐藏左侧栏", exact: true }).click();
  await expect(page.locator(".workspaceSidebarSlot")).toHaveCSS("height", "0px");
  await page.getByRole("button", { name: "显示左侧栏", exact: true }).click();
  await expect(page.locator(".workspaceSidebarSlot")).toHaveCSS("height", "91px");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("opens a human-readable citation without exposing locator JSON", async ({ page }) => {
  let previewFailure = false;
  let previewPdf = false;
  await page.route("http://localhost:8000/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/citations/citation_1/preview") {
      if (previewFailure) return route.fulfill({ status: 415, json: { error: "citation_preview_unsupported" } });
      if (previewPdf) return route.fulfill({ contentType: "application/pdf", body: "%PDF-1.7\n%%EOF\n" });
      return route.fulfill({ contentType: "text/markdown", body: "术前准备\n请核对患者病史。\n确认过敏史。\n完成签字。" });
    }
    const responses = {
      "/api/me": { user: { id: "1", email: "member@example.com", isStaff: false } },
      "/api/workspaces": { workspaces: [{ id: "ws_1", name: "牙科 SOP", description: "", status: "active", role: "owner" }] },
      "/api/workspaces/ws_1/agents": { agents: [{ id: "centaeris", workspaceId: "ws_1", name: "Centaeris", description: "私人 Agent", avatarKind: "centaeris", status: "active", deletedAt: null }] },
      "/api/models": { models: [{ id: "model_1", displayName: "Clinical", provider: "fake", modelName: "fake-model" }] },
      "/api/workspaces/ws_1/session-projects": { projects: [] },
      "/api/workspaces/ws_1/sessions": { sessions: [{ id: "sess_1", workspaceId: "ws_1", title: "术前提醒", origin: "user", status: "active", updatedAt: "2026-07-12T00:00:00Z" }] },
      "/api/sessions/sess_1/assets": { assets: [] },
      "/api/sessions/sess_1/history": historyPage(
        { id: "sess_1", workspaceId: "ws_1", title: "术前提醒", origin: "user", status: "active", updatedAt: "2026-07-12T00:00:00Z" },
        [{
          id: "agent_run_1",
          turnId: "turn_1",
          status: "completed",
          createdAt: "2026-07-12T00:00:00Z",
          startedAt: "2026-07-12T00:00:00Z",
          completedAt: "2026-07-12T00:00:02Z",
          model: { id: "model_1", displayName: "Clinical", provider: "fake", modelName: "fake-model" },
          messages: [
            { messageId: "user_1", role: "user", status: "done", text: "术前提醒" },
            { messageId: "assistant_1", role: "assistant", status: "done", text: "请核对患者病史。" },
          ],
          records: [{
            type: "citation_recorded",
            payload: {
              citationId: "citation_1",
              inputRef: "input_1",
              displayName: "术前须知.md",
              evidenceKind: "workspaceSource",
            },
          }],
        }],
      ),
      "/api/citations/citation_1": {
        citation: {
          citationId: "citation_1",
          inputRef: "input_1",
          displayName: previewPdf ? "单个任务时效性.xlsx" : "术前须知.md",
          evidenceKind: "workspaceSource",
          locator: previewPdf ? { pageStart: 1, pageEnd: 1 } : { startLine: 2, endLine: 4 },
          sourceUrl: "/api/citations/citation_1",
          previewUrl: "/api/citations/citation_1/preview",
          downloadUrl: "/api/source-objects/source_1/download",
          originLabel: "库",
        },
      },
    };
    const response = responses[path];
    return response ? route.fulfill({ json: response }) : route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/w/ws_1/agents/centaeris");
  const citationButton = page.getByRole("button", { name: /术前须知.md/ });
  await citationButton.click();
  let preview = page.getByRole("complementary", { name: "文件预览", exact: true });
  await expect(preview.getByRole("navigation", { name: "文件预览路径" })).toContainText("库");
  await expect(preview.getByRole("link", { name: "下载 术前须知.md", exact: true })).toHaveAttribute("href", /\/api\/source-objects\/source_1\/download$/);
  await expect(preview.locator("mark")).toContainText("请核对患者病史。\n确认过敏史。\n完成签字。");
  await expect(preview).not.toContainText("startLine");
  await preview.getByRole("button", { name: "库", exact: true }).click();
  await expect(citationButton).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await citationButton.click();
  preview = page.getByRole("complementary", { name: "文件预览", exact: true });
  await expect(preview).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await preview.getByRole("button", { name: "关闭预览", exact: true }).click();
  previewFailure = true;
  await citationButton.click();
  preview = page.getByRole("complementary", { name: "文件预览", exact: true });
  await expect(preview.getByRole("alert")).toHaveText("此文件类型暂不支持内嵌预览。");
  previewFailure = false;
  previewPdf = true;
  await preview.getByRole("button", { name: "关闭预览", exact: true }).click();
  await citationButton.click();
  preview = page.getByRole("complementary", { name: "文件预览", exact: true });
  await expect(preview.getByRole("navigation", { name: "文件预览路径" })).toContainText("单个任务时效性.xlsx");
  await expect(preview.locator("iframe")).toHaveAttribute("src", /#page=1$/);
});
