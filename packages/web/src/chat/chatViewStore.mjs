import { applyStreamEntry, isAgentRunActive } from "./sessionEvents.mjs";

function displayPhaseKey(agentRun) {
  return agentRun.connection === "reconnecting" ? "reconnecting" : agentRun.phaseKey || "thinking";
}

function cloneAgentRun(agentRun) {
  return {
    ...agentRun,
    events: (agentRun.events || []).map((stored) => ({ ...stored, event: { ...stored.event, payload: { ...stored.event.payload } } })),
    eventIds: [...(agentRun.eventIds || [])],
    live: agentRun.live ? { ...agentRun.live } : null,
    projectionError: agentRun.projectionError || null,
    messages: (agentRun.messages || []).map((message) => ({
      ...message,
      attachments: (message.attachments || []).map((attachment) => ({ ...attachment })),
      artifacts: (message.artifacts || []).map((artifact) => ({ ...artifact })),
    })),
    activities: (agentRun.activities || []).map((activity) => ({
      ...activity,
      call: { ...activity.call, normalizedInput: { ...(activity.call?.normalizedInput || {}) } },
      result: activity.result ? { ...activity.result, operations: (activity.result.operations || []).map((operation) => ({ ...operation })) } : null,
      waitResult: activity.waitResult ? { ...activity.waitResult } : null,
    })),
    citations: (agentRun.citations || []).map((citation) => ({ ...citation })),
  };
}

export function createChatViewStore({
  now = () => Date.now(),
  monotonicNow = () => performance.now(),
  scheduleFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (frameId) => cancelAnimationFrame(frameId),
  onRenderTelemetry = () => {},
} = {}) {
  const agentRunsById = new Map();
  const messagesById = new Map();
  const messageIdsByAgentRunId = new Map();
  const agentRunListeners = new Map();
  const activityDisclosures = new Map();
  const emptyDisclosures = new Set();
  const listListeners = new Set();
  const changeListeners = new Set();
  const pendingRenderTelemetry = new Map();
  const renderTelemetryFrames = new Map();
  const streamRenderRevisions = new Map();
  let orderedAgentRunIds = Object.freeze([]);
  let listSnapshot = Object.freeze({ agentRunIds: orderedAgentRunIds, hasActiveAgentRun: false });

  const cancelRenderTelemetry = (agentRunId, telemetry = null) => {
    const scheduled = renderTelemetryFrames.get(agentRunId);
    if (scheduled && (!telemetry || scheduled.telemetry === telemetry)) {
      cancelFrame(scheduled.frameId);
      renderTelemetryFrames.delete(agentRunId);
    }
    if (!telemetry || pendingRenderTelemetry.get(agentRunId) === telemetry) {
      pendingRenderTelemetry.delete(agentRunId);
    }
  };

  const clearRenderTelemetry = () => {
    [...renderTelemetryFrames.keys()].forEach((agentRunId) => cancelRenderTelemetry(agentRunId));
    pendingRenderTelemetry.clear();
  };

  const rebuildMessages = (agentRun) => {
    const previousIds = messageIdsByAgentRunId.get(agentRun.id) || [];
    previousIds.forEach((messageId) => messagesById.delete(messageId));
    const ids = [];
    for (const message of agentRun.messages || []) {
      if (messagesById.has(message.messageId)) throw new Error(`duplicate messageId: ${message.messageId}`);
      ids.push(message.messageId);
      messagesById.set(message.messageId, message);
    }
    messageIdsByAgentRunId.set(agentRun.id, Object.freeze(ids));
  };

  const emitList = () => {
    listSnapshot = Object.freeze({
      agentRunIds: orderedAgentRunIds,
      hasActiveAgentRun: orderedAgentRunIds.some((agentRunId) => isAgentRunActive(agentRunsById.get(agentRunId))),
    });
    listListeners.forEach((listener) => listener());
  };

  const emitAgentRun = (agentRunId, listMayHaveChanged = false) => {
    agentRunListeners.get(agentRunId)?.forEach((listener) => listener());
    changeListeners.forEach((listener) => listener(agentRunId));
    if (listMayHaveChanged) emitList();
  };

  const putAgentRun = (agentRun) => {
    const cloned = cloneAgentRun(agentRun);
    agentRunsById.set(cloned.id, cloned);
    if (!streamRenderRevisions.has(cloned.id)) streamRenderRevisions.set(cloned.id, 0);
    rebuildMessages(cloned);
    return cloned;
  };

  return {
    getListSnapshot: () => listSnapshot,
    getAgentRunSnapshot: (agentRunId) => agentRunsById.get(agentRunId) || null,
    getMessageSnapshot: (messageId) => messagesById.get(messageId) || null,
    getMessageIdsForAgentRun: (agentRunId) => messageIdsByAgentRunId.get(agentRunId) || Object.freeze([]),
    getStreamRenderRevision: (agentRunId) => streamRenderRevisions.get(agentRunId) || 0,
    getActivityDisclosures: (agentRunId) => activityDisclosures.get(agentRunId) || emptyDisclosures,
    toggleActivityDisclosure(agentRunId, identity) {
      if (!agentRunsById.has(agentRunId)) throw new Error(`unknown agentRunId: ${agentRunId}`);
      const expanded = new Set(activityDisclosures.get(agentRunId));
      if (expanded.has(identity)) expanded.delete(identity);
      else expanded.add(identity);
      if (expanded.size) activityDisclosures.set(agentRunId, expanded);
      else activityDisclosures.delete(agentRunId);
      agentRunListeners.get(agentRunId)?.forEach((listener) => listener());
    },
    subscribeList(listener) {
      listListeners.add(listener);
      return () => listListeners.delete(listener);
    },
    subscribeAgentRun(agentRunId, listener) {
      if (!agentRunId) return () => {};
      if (!agentRunListeners.has(agentRunId)) agentRunListeners.set(agentRunId, new Set());
      agentRunListeners.get(agentRunId).add(listener);
      return () => {
        const listeners = agentRunListeners.get(agentRunId);
        listeners?.delete(listener);
        if (listeners?.size === 0) agentRunListeners.delete(agentRunId);
      };
    },
    subscribeChanges(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    clear() {
      clearRenderTelemetry();
      activityDisclosures.clear();
      const previousIds = orderedAgentRunIds;
      agentRunsById.clear();
      messagesById.clear();
      messageIdsByAgentRunId.clear();
      streamRenderRevisions.clear();
      orderedAgentRunIds = Object.freeze([]);
      previousIds.forEach((agentRunId) => agentRunListeners.get(agentRunId)?.forEach((listener) => listener()));
      emitList();
    },
    replaceAll(agentRuns) {
      clearRenderTelemetry();
      const nextIds = [];
      const seen = new Set();
      agentRunsById.clear();
      messagesById.clear();
      messageIdsByAgentRunId.clear();
      streamRenderRevisions.clear();
      for (const agentRun of agentRuns) {
        if (seen.has(agentRun.id)) throw new Error(`duplicate agentRunId: ${agentRun.id}`);
        seen.add(agentRun.id);
        nextIds.push(agentRun.id);
        putAgentRun(agentRun);
      }
      orderedAgentRunIds = Object.freeze(nextIds);
      for (const agentRunId of activityDisclosures.keys()) {
        if (!seen.has(agentRunId)) activityDisclosures.delete(agentRunId);
      }
      emitList();
      nextIds.forEach((agentRunId) => emitAgentRun(agentRunId));
    },
    prependAgentRuns(agentRuns) {
      if (!agentRuns.length) return;
      const existing = new Set(orderedAgentRunIds);
      const newIds = [];
      for (const agentRun of agentRuns) {
        if (existing.has(agentRun.id) || newIds.includes(agentRun.id)) throw new Error(`history page overlaps agentRunId: ${agentRun.id}`);
        newIds.push(agentRun.id);
        putAgentRun(agentRun);
      }
      orderedAgentRunIds = Object.freeze([...newIds, ...orderedAgentRunIds]);
      emitList();
    },
    appendAgentRun(agentRun) {
      if (agentRunsById.has(agentRun.id)) throw new Error(`duplicate agentRunId: ${agentRun.id}`);
      putAgentRun(agentRun);
      orderedAgentRunIds = Object.freeze([...orderedAgentRunIds, agentRun.id]);
      emitList();
      emitAgentRun(agentRun.id);
    },
    replaceAgentRun(agentRun) {
      if (!agentRunsById.has(agentRun.id)) throw new Error(`unknown agentRunId: ${agentRun.id}`);
      const previous = agentRunsById.get(agentRun.id);
      putAgentRun(agentRun);
      emitAgentRun(agentRun.id, isAgentRunActive(previous) !== isAgentRunActive(agentRun));
    },
    replaceAgentRunId(previousAgentRunId, agentRun) {
      const index = orderedAgentRunIds.indexOf(previousAgentRunId);
      if (index < 0) throw new Error(`unknown pending agentRunId: ${previousAgentRunId}`);
      if (previousAgentRunId !== agentRun.id && agentRunsById.has(agentRun.id)) throw new Error(`duplicate agentRunId: ${agentRun.id}`);
      const previousMessageIds = messageIdsByAgentRunId.get(previousAgentRunId) || [];
      previousMessageIds.forEach((messageId) => messagesById.delete(messageId));
      messageIdsByAgentRunId.delete(previousAgentRunId);
      agentRunsById.delete(previousAgentRunId);
      activityDisclosures.delete(previousAgentRunId);
      const streamRenderRevision = streamRenderRevisions.get(previousAgentRunId) || 0;
      streamRenderRevisions.delete(previousAgentRunId);
      putAgentRun(agentRun);
      streamRenderRevisions.set(agentRun.id, streamRenderRevision);
      orderedAgentRunIds = Object.freeze(orderedAgentRunIds.map((agentRunId) => agentRunId === previousAgentRunId ? agentRun.id : agentRunId));
      agentRunListeners.get(previousAgentRunId)?.forEach((listener) => listener());
      emitList();
      emitAgentRun(agentRun.id);
    },
    updateConnection(agentRunId, connection) {
      const agentRun = agentRunsById.get(agentRunId);
      if (!agentRun) throw new Error(`unknown agentRunId: ${agentRunId}`);
      const wasActive = isAgentRunActive(agentRun);
      const next = { ...agentRun, connection };
      if (displayPhaseKey(next) !== displayPhaseKey(agentRun)) next.phaseStartedAtMs = now();
      agentRunsById.set(agentRunId, next);
      emitAgentRun(agentRunId, wasActive !== isAgentRunActive(next));
    },
    rejectPendingAgentRun(agentRunId) {
      if (!agentRunId.startsWith("pending:")) throw new Error("only a pending AgentRun may be rejected locally");
      const agentRun = agentRunsById.get(agentRunId);
      if (!agentRun) return;
      if (!isAgentRunActive(agentRun)) return;
      const next = {
        ...agentRun,
        status: "failed",
        connection: "failed",
        finishedAtMs: now(),
      };
      agentRunsById.set(agentRunId, next);
      emitAgentRun(agentRunId, true);
    },
    markAgentRunProjectionError(agentRunId) {
      const agentRun = agentRunsById.get(agentRunId);
      if (!agentRun) return;
      agentRunsById.set(agentRunId, {
        ...agentRun,
        live: null,
        projectionError: "session_projection_invalid",
      });
      emitAgentRun(agentRunId);
    },
    beginStreamTelemetry(entry, acceptedOrdinal) {
      return Object.freeze({
        entry,
        acceptedAt: monotonicNow(),
        acceptedOrdinal,
        agentRunId: entry.item.agentRunId,
        streamItemKind: entry.item.kind,
      });
    },
    applyStreamEntries(entries, telemetry = []) {
      if (telemetry.length && telemetry.length !== entries.length) throw new Error("stream telemetry batch length mismatch");
      const changed = new Map();
      const activeChanges = new Set();
      for (const entry of entries) {
        const agentRunId = entry.item.agentRunId;
        const current = changed.get(agentRunId) || agentRunsById.get(agentRunId);
        if (!current) throw new Error(`session stream references unknown agentRunId: ${agentRunId}`);
        const wasActive = isAgentRunActive(current);
        let next = applyStreamEntry(current, entry);
        if (displayPhaseKey(next) === displayPhaseKey(current)) {
          next = { ...next, phaseStartedAtMs: current.phaseStartedAtMs };
        }
        if (wasActive !== isAgentRunActive(next)) activeChanges.add(agentRunId);
        changed.set(agentRunId, next);
      }
      const reducerAppliedAt = telemetry.length ? monotonicNow() : null;
      changed.forEach((_, agentRunId) => {
        streamRenderRevisions.set(agentRunId, (streamRenderRevisions.get(agentRunId) || 0) + 1);
      });
      telemetry.forEach((item, index) => {
        if (!item || item.entry !== entries[index]) throw new Error("stream telemetry entry mismatch");
        if (!changed.has(item.agentRunId)) throw new Error("stream telemetry AgentRun mismatch");
        cancelRenderTelemetry(item.agentRunId);
        pendingRenderTelemetry.set(item.agentRunId, {
          ...item,
          renderRevision: streamRenderRevisions.get(item.agentRunId),
          reducerAppliedAt,
        });
      });
      changed.forEach((agentRun, agentRunId) => {
        agentRunsById.set(agentRunId, agentRun);
        rebuildMessages(agentRun);
        emitAgentRun(agentRunId, activeChanges.has(agentRunId));
      });
    },
    markDomCommit(agentRunId, renderRevision) {
      const telemetry = pendingRenderTelemetry.get(agentRunId);
      if (!telemetry || telemetry.renderRevision !== renderRevision) return undefined;
      telemetry.domCommitAt = monotonicNow();
      const schedule = (callback) => {
        const frameId = scheduleFrame(callback);
        renderTelemetryFrames.set(agentRunId, { frameId, telemetry });
      };
      schedule(() => {
        if (pendingRenderTelemetry.get(agentRunId) !== telemetry) return;
        schedule(() => {
          if (pendingRenderTelemetry.get(agentRunId) !== telemetry) return;
          const domPaintBoundaryAt = monotonicNow();
          pendingRenderTelemetry.delete(agentRunId);
          renderTelemetryFrames.delete(agentRunId);
          const metric = Object.freeze({
            schema: "workspace.chat_render_telemetry.v1",
            agentRunId,
            acceptedOrdinal: telemetry.acceptedOrdinal,
            streamItemKind: telemetry.streamItemKind,
            acceptedAt: telemetry.acceptedAt,
            reducerAppliedAt: telemetry.reducerAppliedAt,
            domCommitAt: telemetry.domCommitAt,
            domPaintBoundaryAt,
            acceptedToReducerMs: telemetry.reducerAppliedAt - telemetry.acceptedAt,
            reducerToDomCommitMs: telemetry.domCommitAt - telemetry.reducerAppliedAt,
            domCommitToPaintBoundaryMs: domPaintBoundaryAt - telemetry.domCommitAt,
            acceptedToDomPaintBoundaryMs: domPaintBoundaryAt - telemetry.acceptedAt,
          });
          try {
            onRenderTelemetry(metric);
          } catch {
            // Telemetry must never break chat rendering.
          }
        });
      });
      return () => cancelRenderTelemetry(agentRunId, telemetry);
    },
  };
}
