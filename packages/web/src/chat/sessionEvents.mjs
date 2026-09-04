const AGENT_RUN_STATUSES = new Set(["queued", "running", "completed", "failed", "cancelled"]);
const VISIBLE_EVENT_TYPES = new Set([
  "agent_run_started", "user_message", "turn_supplement", "assistant_message", "tool_call",
  "tool_result", "phase_event", "external_evidence_ref", "citation_recorded",
  "artifact_published", "compaction", "tombstone", "agent_run_completed", "agent_run_failed",
  "agent_run_interrupted",
]);
const TERMINAL_EVENT_TYPES = new Set(["agent_run_completed", "agent_run_failed", "agent_run_interrupted"]);
const STREAM_ITEM_FIELDS = {
  committed: ["event", "kind", "agentRunId", "schema", "sourceSequence"],
  live: ["afterSequence", "kind", "messageId", "revision", "agentRunId", "schema", "text", "turnId"],
};

export const HISTORY_PAGE_SCHEMA = "session.history.page.v1";

function hasExactFields(value, fields) {
  return Object.keys(value).sort().join("|") === [...fields].sort().join("|");
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function requireString(value, name, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`${name} must be a string`);
  return value;
}

function validateSessionEvent(event, identity = {}) {
  requireObject(event, "session event");
  const required = ["sessionId", "createdAtMs", "eventId", "eventVersion", "payload", "schemaVersion", "sequence", "type"];
  const allowed = new Set([...required, "agentRunId", "turnId"]);
  if (required.some((field) => !(field in event)) || Object.keys(event).some((field) => !allowed.has(field))) {
    throw new Error("session event fields mismatch");
  }
  if (event.schemaVersion !== "session.event.v1" || event.eventVersion !== 1 || !VISIBLE_EVENT_TYPES.has(event.type)) {
    throw new Error("session event schema or type is unsupported");
  }
  for (const field of ["eventId", "sessionId"]) requireString(event[field], `session event ${field}`);
  if (!Number.isInteger(event.createdAtMs) || event.createdAtMs < 0) throw new Error("session event createdAtMs is invalid");
  if (!Number.isInteger(event.sequence) || event.sequence <= 0) throw new Error("session event sequence is invalid");
  requireObject(event.payload, "session event payload");
  if (identity.sessionId && event.sessionId !== identity.sessionId) throw new Error("session event session binding mismatch");
  if (identity.agentRunId && event.agentRunId !== identity.agentRunId) throw new Error("Session event AgentRun binding mismatch");
  return event;
}

function validateOperation(operation, callId) {
  requireObject(operation, "tool operation");
  for (const field of ["callId", "toolName", "status", "resultState"]) {
    requireString(operation[field], `tool operation ${field}`);
  }
  if (operation.callId !== callId) throw new Error("tool operation call binding mismatch");
  if (Object.hasOwn(operation, "title")) throw new Error("tool operation title is removed");
  if (operation.toolName === "bash") {
    if (operation.kind !== "command") throw new Error("bash tool operation kind must be command");
  } else if (Object.hasOwn(operation, "kind")) {
    throw new Error("non-bash tool operation kind is removed");
  }
  if (["write", "edit"].includes(operation.toolName)) {
    const failed = ["failed", "denied", "aborted"].includes(operation.resultState);
    if (failed && Object.hasOwn(operation, "diffPreview")) throw new Error("failed mutation operation must not carry diffPreview");
    if (!failed) requireString(operation.diffPreview, "successful mutation diffPreview");
  }
  return { ...operation };
}

export function validateActivity(activity) {
  requireObject(activity, "activity");
  for (const field of ["activityId", "callId", "turnId", "toolName", "status"]) {
    requireString(activity[field], `activity ${field}`);
  }
  requireObject(activity.call, "activity tool call");
  if (activity.call.callId !== activity.callId || activity.call.toolName !== activity.toolName) {
    throw new Error("activity tool call identity mismatch");
  }
  if (activity.result !== null) {
    requireObject(activity.result, "activity tool result");
    if (activity.result.callId !== activity.callId || activity.result.toolName !== activity.toolName) {
      throw new Error("activity tool result identity mismatch");
    }
  }
  return { ...activity, call: { ...activity.call }, result: activity.result ? { ...activity.result } : null };
}

function upsertBy(items, key, value) {
  const index = items.findIndex((item) => item[key] === value[key]);
  return index < 0 ? [...items, value] : items.map((item, itemIndex) => itemIndex === index ? value : item);
}

function artifactLink(payload) {
  requireString(payload.artifactRef, "artifactRef");
  requireString(payload.filename, "artifact filename");
  const artifactId = payload.artifactRef.startsWith("artifact:") ? payload.artifactRef.slice(9) : "";
  if (!artifactId) throw new Error("artifactRef is invalid");
  return { artifactRef: payload.artifactRef, filename: payload.filename, downloadUrl: `/api/artifacts/${artifactId}/download` };
}

function commitOverlayBarrier(view, event, sequence) {
  requireString(event.turnId, `${event.type} turnId`);
  const previousBarrier = Object.hasOwn(view.overlayBarrierByTurnId, event.turnId)
    ? view.overlayBarrierByTurnId[event.turnId]
    : 0;
  const barrier = Math.max(previousBarrier, sequence);
  const supersedesLive = view.live?.turnId === event.turnId && view.live.afterSequence < barrier;
  return {
    ...view,
    overlayBarrierByTurnId: barrier === previousBarrier
      ? view.overlayBarrierByTurnId
      : { ...view.overlayBarrierByTurnId, [event.turnId]: barrier },
    messages: supersedesLive
      ? view.messages.filter((message) => message.messageId !== view.live.messageId)
      : view.messages,
    live: supersedesLive ? null : view.live,
  };
}

function applySessionEvent(view, event, sequence) {
  const payload = event.payload;
  if (event.type === "agent_run_started") {
    return { ...view, startedAtMs: event.createdAtMs };
  }
  if (event.type === "user_message") {
    requireString(payload.messageId, "user messageId");
    requireString(payload.text, "user text");
    if (!Array.isArray(payload.attachments)) throw new Error("user attachments are invalid");
    return {
      ...view,
      messages: upsertBy(view.messages, "messageId", {
        messageId: payload.messageId, turnId: event.turnId, sequence, role: "user", phase: "user",
        status: "done", text: payload.text, createdAtMs: event.createdAtMs,
        attachments: payload.attachments.map((item) => ({ ...item })), artifacts: [],
      }),
    };
  }
  if (event.type === "turn_supplement") {
    requireString(payload.messageId, "supplement messageId");
    requireString(payload.message, "supplement message");
    return {
      ...view,
      messages: upsertBy(view.messages, "messageId", {
        messageId: payload.messageId, turnId: event.turnId, sequence, role: "user", phase: "user",
        status: "done", text: payload.message, createdAtMs: event.createdAtMs, attachments: [], artifacts: [],
      }),
    };
  }
  if (event.type === "phase_event") {
    requireString(payload.message, "phase message");
    const messageId = `message:${event.turnId}:phase:${event.eventId}`;
    const next = commitOverlayBarrier(view, event, sequence);
    return {
      ...next,
      messages: upsertBy(next.messages, "messageId", {
        messageId, turnId: event.turnId, sequence, role: "assistant", phase: "stage",
        status: "done", text: payload.message, createdAtMs: event.createdAtMs, attachments: [], artifacts: [],
      }),
    };
  }
  if (event.type === "compaction") {
    for (const field of ["compactionId", "summaryMessageId", "summaryMarkdown", "createdReason"]) {
      requireString(payload[field], `compaction ${field}`);
    }
    if (payload.firstKeptMessageId !== null) {
      requireString(payload.firstKeptMessageId, "compaction firstKeptMessageId");
    }
    return {
      ...view,
      messages: upsertBy(view.messages, "messageId", {
        messageId: `message:${event.turnId}:compaction:${event.eventId}`,
        turnId: event.turnId,
        sequence,
        role: "assistant",
        phase: "compaction",
        status: "done",
        text: "Compacted conversation",
        createdAtMs: event.createdAtMs,
        attachments: [],
        artifacts: [],
      }),
    };
  }
  if (event.type === "tool_call") {
    for (const field of ["callId", "toolName", "toolContractDigest", "providerId", "displayTarget"]) requireString(payload[field], `tool_call ${field}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(payload.toolContractDigest)) throw new Error("tool_call toolContractDigest is invalid");
    requireObject(payload.normalizedInput, "tool_call normalizedInput");
    const outputRef = payload.toolName === "task_output" ? payload.normalizedInput?.output_ref : null;
    if (outputRef?.kind === "agent" && typeof outputRef.child_session_id === "string") {
      const agent = view.activities.find((item) => item.toolName === "agent" && item.childSessionId === outputRef.child_session_id);
      if (!agent) throw new Error("task_output has no matching Agent activity");
      return {
        ...view,
        agentWaits: { ...view.agentWaits, [payload.callId]: agent.activityId },
      };
    }
    return {
      ...view,
      activities: upsertBy(view.activities, "activityId", {
        activityId: `activity:${payload.callId}`, callId: payload.callId, toolName: payload.toolName,
        turnId: event.turnId, sequence, status: "running", childSessionId: null,
        call: { ...payload }, result: null, waitResult: null,
      }),
    };
  }
  if (event.type === "tool_result") {
    for (const field of ["callId", "toolName", "resultState"]) requireString(payload[field], `tool_result ${field}`);
    if (!Array.isArray(payload.operations)) throw new Error("tool_result operations are invalid");
    const rawResult = {
      ...payload,
      operations: payload.operations.map((operation) => validateOperation(operation, payload.callId)),
    };
    const waitingActivityId = view.agentWaits[payload.callId];
    if (waitingActivityId) {
      const status = ["failed", "denied", "aborted"].includes(payload.resultState) ? "failed" : "completed";
      return {
        ...view,
        activities: view.activities.map((activity) => activity.activityId === waitingActivityId
          ? { ...activity, status, waitResult: rawResult }
          : activity),
      };
    }
    const index = view.activities.findIndex((item) => item.callId === payload.callId);
    if (index < 0 || view.activities[index].toolName !== payload.toolName) throw new Error("tool_result has no matching tool_call");
    const current = view.activities[index];
    let status = ["failed", "denied", "aborted"].includes(payload.resultState) ? "failed" : "completed";
    let childSessionId = current.childSessionId;
    if (current.toolName === "agent") {
      try {
        const result = JSON.parse(payload.modelContent);
        if (result?.schema === "agent_tool_result_v1" && result.status === "started") {
          status = "running";
          childSessionId = result.childSessionId;
        }
      } catch {
        if (status === "completed") throw new Error("Agent tool result is invalid JSON");
      }
    }
    const activity = {
      ...current,
      status,
      childSessionId,
      result: rawResult,
    };
    return { ...view, activities: view.activities.map((item, itemIndex) => itemIndex === index ? activity : item) };
  }
  if (event.type === "citation_recorded") {
    for (const field of ["citationId", "inputRef", "displayName", "evidenceKind"]) requireString(payload[field], `citation ${field}`);
    return {
      ...view,
      citations: upsertBy(view.citations, "citationId", {
        ...payload,
        sourceUrl: `/api/citations/${payload.citationId}`,
      }),
    };
  }
  if (event.type === "artifact_published") {
    const artifact = artifactLink(payload);
    return { ...view, artifacts: upsertBy(view.artifacts, "artifactRef", artifact) };
  }
  if (event.type === "assistant_message") {
    requireString(payload.messageId, "assistant messageId");
    requireString(payload.modelMarkdown, "assistant modelMarkdown", true);
    if (!Array.isArray(payload.artifactRefs)) throw new Error("assistant artifactRefs are invalid");
    const artifacts = payload.artifactRefs.map((reference) => {
      const artifact = view.artifacts.find((item) => item.artifactRef === reference);
      if (!artifact) throw new Error("assistant references an unknown artifact");
      return artifact;
    });
    const next = commitOverlayBarrier(view, event, sequence);
    return {
      ...next,
      messages: upsertBy(next.messages, "messageId", {
        messageId: payload.messageId, turnId: event.turnId, sequence, role: "assistant", phase: "final",
        status: payload.status, text: payload.modelMarkdown, createdAtMs: event.createdAtMs, attachments: [], artifacts,
      }),
    };
  }
  if (TERMINAL_EVENT_TYPES.has(event.type)) {
    const status = event.type === "agent_run_completed" ? "completed" : event.type === "agent_run_failed" ? "failed" : "cancelled";
    return {
      ...view,
      status,
      connection: status,
      finishedAtMs: event.createdAtMs,
      failureReason: event.type === "agent_run_failed" ? payload.reasonType : view.failureReason,
      interruptionReason: event.type === "agent_run_interrupted" ? payload.reasonType : view.interruptionReason,
      live: null,
    };
  }
  return view;
}

function applyLive(view, live) {
  if (live === null) return view;
  requireObject(live, "live assistant");
  if (!hasExactFields(live, ["afterSequence", "messageId", "revision", "text", "turnId"])) throw new Error("live assistant fields mismatch");
  for (const field of ["messageId", "turnId"]) requireString(live[field], `live ${field}`);
  requireString(live.text, "live text", true);
  if (!Number.isInteger(live.afterSequence) || live.afterSequence < 0 || !Number.isInteger(live.revision) || live.revision <= 0) {
    throw new Error("live assistant sequence is invalid");
  }
  const barrier = Object.hasOwn(view.overlayBarrierByTurnId, live.turnId)
    ? view.overlayBarrierByTurnId[live.turnId]
    : 0;
  if (live.afterSequence < barrier) return view;
  if (!live.text) return { ...view, live: { ...live } };
  const messages = view.messages.filter((message) => message.messageId !== live.messageId);
  messages.push({
    messageId: live.messageId, turnId: live.turnId, sequence: live.afterSequence + 0.5,
    role: "assistant", phase: "active", status: "streaming", text: live.text,
    attachments: [], artifacts: [],
  });
  return { ...view, messages, live: { ...live } };
}

function projectAgentRun(agentRun) {
  const initialStartedAtMs = Date.parse(agentRun.startedAt || agentRun.createdAt || "");
  let view = {
    ...agentRun,
    messages: [],
    activities: [],
    citations: [],
    artifacts: [],
    agentWaits: {},
    overlayBarrierByTurnId: {},
    startedAtMs: initialStartedAtMs,
    phaseKey: "thinking",
    phaseStartedAtMs: initialStartedAtMs,
    finishedAtMs: agentRun.completedAt ? Date.parse(agentRun.completedAt) : null,
    connection: ["queued", "running"].includes(agentRun.status) ? (agentRun.streamCursor === "0-0" ? "starting" : "running") : agentRun.status,
    live: null,
    projectionError: null,
  };
  let previousSequence = 0;
  const eventIds = new Set();
  for (const stored of agentRun.events) {
    requireObject(stored, "stored session event");
    if (!hasExactFields(stored, ["event", "sequence"]) || !Number.isInteger(stored.sequence) || stored.sequence <= previousSequence) {
      throw new Error("stored session event ordering is invalid");
    }
    const event = validateSessionEvent(stored.event, { sessionId: agentRun.sessionId, agentRunId: agentRun.id });
    if (event.sequence !== stored.sequence) throw new Error("stored session event sequence binding mismatch");
    if (eventIds.has(event.eventId)) throw new Error("duplicate session eventId");
    eventIds.add(event.eventId);
    previousSequence = stored.sequence;
    const previousPhaseKey = view.phaseKey;
    view = applySessionEvent(view, event, stored.sequence);
    const runningActivity = view.activities.findLast((activity) => activity.status === "running");
    const phaseKey = runningActivity ? `tool:${runningActivity.activityId}` : "thinking";
    view = {
      ...view,
      phaseKey,
      phaseStartedAtMs: event.type === "agent_run_started" || phaseKey !== previousPhaseKey
        ? event.createdAtMs
        : view.phaseStartedAtMs,
    };
  }
  view = applyLive(view, agentRun.live);
  return { ...view, eventIds: [...eventIds], lastSourceSequence: previousSequence };
}

export function hydrateAgentRun(agentRun, identity = {}) {
  requireObject(agentRun, "agent run history");
  const fields = ["completedAt", "createdAt", "events", "id", "live", "model", "startedAt", "status", "streamCursor"];
  if (!hasExactFields(agentRun, fields) || !AGENT_RUN_STATUSES.has(agentRun.status) || !Array.isArray(agentRun.events)) throw new Error("agent run history fields are invalid");
  requireString(agentRun.id, "agent run id");
  requireString(agentRun.streamCursor, "agent run streamCursor");
  if (identity.sessionId) agentRun = { ...agentRun, sessionId: identity.sessionId };
  if (identity.workspaceId) agentRun = { ...agentRun, workspaceId: identity.workspaceId };
  return projectAgentRun(agentRun);
}

function quarantineAgentRun(agentRun, identity) {
  requireObject(agentRun, "agent run history");
  requireString(agentRun.id, "agent run id");
  if (!AGENT_RUN_STATUSES.has(agentRun.status)) throw new Error("agent run history status is invalid");
  return {
    ...agentRun,
    sessionId: identity.sessionId,
    workspaceId: identity.workspaceId,
    events: [],
    messages: [],
    activities: [],
    citations: [],
    artifacts: [],
    agentWaits: {},
    overlayBarrierByTurnId: {},
    eventIds: [],
    lastSourceSequence: 0,
    live: null,
    connection: ["queued", "running"].includes(agentRun.status) ? "running" : agentRun.status,
    projectionError: "session_projection_invalid",
  };
}

export function validateHistoryPage(page, expectedIdentity = {}) {
  const fields = ["agentRuns", "hasMore", "nextCursor", "schema", "session"];
  if (!page || typeof page !== "object" || !hasExactFields(page, fields) || page.schema !== HISTORY_PAGE_SCHEMA || !Array.isArray(page.agentRuns)) {
    throw new Error("invalid session history page");
  }
  requireObject(page.session, "history session");
  requireString(page.session.id, "history session id");
  requireString(page.session.workspaceId, "history workspace id");
  if ((expectedIdentity.sessionId && page.session.id !== expectedIdentity.sessionId) || (expectedIdentity.workspaceId && page.session.workspaceId !== expectedIdentity.workspaceId)) {
    throw new Error("session history identity mismatch");
  }
  if (typeof page.hasMore !== "boolean" || (page.nextCursor !== null && typeof page.nextCursor !== "string") || page.hasMore !== Boolean(page.nextCursor)) {
    throw new Error("invalid session history cursor");
  }
  const identity = { sessionId: page.session.id, workspaceId: page.session.workspaceId };
  const agentRuns = page.agentRuns.map((agentRun) => {
    try {
      return hydrateAgentRun(agentRun, identity);
    } catch {
      return quarantineAgentRun(agentRun, identity);
    }
  });
  if (new Set(agentRuns.map((agentRun) => agentRun.id)).size !== agentRuns.length) throw new Error("duplicate agentRunId");
  return { ...page, agentRuns };
}

function validateStreamItem(item, agentRunId) {
  requireObject(item, "session stream item");
  const fields = STREAM_ITEM_FIELDS[item.kind];
  if (!fields || !hasExactFields(item, fields) || item.schema !== "session.stream.item.v1" || item.agentRunId !== agentRunId) {
    throw new Error("session stream item fields or binding are invalid");
  }
  if (item.kind === "committed") {
    if (!Number.isInteger(item.sourceSequence) || item.sourceSequence <= 0) throw new Error("sourceSequence is invalid");
    const event = validateSessionEvent(item.event, { agentRunId });
    if (event.sequence !== item.sourceSequence) throw new Error("stream session event sequence binding mismatch");
  } else {
    if (!Number.isInteger(item.afterSequence) || item.afterSequence < 0 || !Number.isInteger(item.revision) || item.revision <= 0) throw new Error("live stream sequence is invalid");
    for (const field of ["messageId", "turnId"]) requireString(item[field], `live ${field}`);
    requireString(item.text, "live text", true);
  }
  return item;
}

export function readSseBlock(block, agentRunId) {
  let cursor = null;
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("id:")) cursor = line.slice(3).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  return { cursor, item: validateStreamItem(JSON.parse(dataLines.join("\n")), agentRunId) };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

export async function readSse(response, agentRunId, onItem, { signal } = {}) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("stream body is unavailable");
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  const deliver = async (block) => {
    throwIfAborted(signal);
    const entry = readSseBlock(block, agentRunId);
    if (!entry) return;
    if (terminal) throw new Error("session stream emitted an item after terminal");
    await onItem(entry);
    terminal = entry.item.kind === "committed" && TERMINAL_EVENT_TYPES.has(entry.item.event.type);
  };
  while (true) {
    throwIfAborted(signal);
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) await deliver(block);
  }
  buffer += decoder.decode();
  if (buffer.trim()) await deliver(buffer);
  return terminal;
}

export function applyStreamEntry(agentRun, entry) {
  const { cursor, item } = entry;
  if (item.agentRunId !== agentRun.id) throw new Error("Session stream AgentRun binding mismatch");
  const events = agentRun.events || [];
  if (item.kind === "committed") {
    if (agentRun.eventIds?.includes(item.event.eventId)) return { ...agentRun, streamCursor: cursor || agentRun.streamCursor };
    return projectAgentRun({
      ...agentRun,
      events: [...events, { sequence: item.sourceSequence, event: item.event }].sort((left, right) => left.sequence - right.sequence),
      live: TERMINAL_EVENT_TYPES.has(item.event.type) ? null : agentRun.live,
      streamCursor: cursor || agentRun.streamCursor,
    });
  }
  if (agentRun.live?.messageId === item.messageId && item.revision <= agentRun.live.revision) {
    return { ...agentRun, streamCursor: cursor || agentRun.streamCursor };
  }
  return projectAgentRun({
    ...agentRun,
    live: {
      messageId: item.messageId,
      turnId: item.turnId,
      afterSequence: item.afterSequence,
      revision: item.revision,
      text: item.text,
    },
    streamCursor: cursor || agentRun.streamCursor,
  });
}

export function isAgentRunActive(agentRun) {
  return ["queued", "running"].includes(agentRun.status);
}
