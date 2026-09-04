import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useRouteLoaderData } from "react-router";
import { apiResponse } from "../api";
import { WorkspaceContextPanel } from "../components/WorkspaceContextPanel";
import { ContextUsagePicker } from "../components/ContextUsagePicker";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useModalDialog } from "../components/useModalDialog";
import { createChatViewStore } from "../chat/chatViewStore.mjs";
import { useAgentRunList } from "../chat/chatStoreHooks";
import { isAgentRunActive, validateHistoryPage } from "../chat/sessionEvents.mjs";
import { WorkspaceChatController } from "../chat/workspaceChatController.mjs";
import { streamWorkspaceAgentRun } from "../chat/workspaceWebTransport.mjs";
import { VirtualAgentRunList } from "../chat/VirtualAgentRunList";
import { AttachmentCard, LocalAttachmentCard, localAttachmentKey } from "../chat/AttachmentCard";
import {
  attachmentCanPreview,
  attachmentDownloadUrl,
  attachmentIsImage,
  attachmentPreviewUrl,
} from "../chat/attachments.mjs";
import { MAX_UPLOAD_BATCH_FILES } from "../upload";
import { useEnterStartsNewLine } from "../preferences";
import { HomePlane, HomeQuickActions } from "../shell/HomePlane";
import { AgentMark } from "../shell/AgentMark";
import { ShellSidebar } from "../shell/ShellSidebar";
import {
  ArrowUp,
  ChartNoAxesColumnIncreasing,
  Check,
  ChevronDown,
  Ellipsis,
  Image as ImageIcon,
  LoaderCircle,
  Mail,
  MailOpen,
  MessageSquare,
  PanelLeft,
  Plus,
  Pencil,
  Pin,
  PinOff,
  Square,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";

const CLOSED_CONTEXT_PANEL = Object.freeze({ mode: "closed" });

const THINKING_MODE_LABELS = Object.freeze({
  none: "关闭",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
});

const ARTIFACT_PREVIEW_MAX_BYTES = 1024 * 1024;
const ARTIFACT_PREVIEW_CONTENT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function publishChatRenderTelemetry(metric) {
  window.dispatchEvent(new CustomEvent("centaeris:chat-render-telemetry", { detail: metric }));
}

function upsertBy(items, key, value) {
  const index = items.findIndex((item) => item[key] === value[key]);
  if (index < 0) return [...items, value];
  return items.map((item, itemIndex) => (itemIndex === index ? value : item));
}

function sortSessions(items) {
  return [...items].sort((left, right) => (
    Number(Boolean(right.isPinned)) - Number(Boolean(left.isPinned))
    || String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))
  ));
}

function thinkingModeLabel(mode) {
  return THINKING_MODE_LABELS[mode] || mode;
}

function closeComposerPicker(event) {
  event.currentTarget.closest("details")?.removeAttribute("open");
}

function closeComposerPickerOnBlur(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.removeAttribute("open");
}

function closeComposerPickerOnEscape(event) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.currentTarget.removeAttribute("open");
  event.currentTarget.querySelector("summary")?.focus();
}

function ComposerThinkingPicker({ model, value, onChange, disabled }) {
  const modes = model?.thinkingModes || [];
  return <details className="workspaceComposerPicker workspaceComposerThinking" onBlur={closeComposerPickerOnBlur} onKeyDown={closeComposerPickerOnEscape}>
    <summary
      role="button"
      aria-label="思考力度"
      aria-disabled={disabled}
      aria-haspopup="menu"
      onClick={(event) => disabled && event.preventDefault()}
    ><ChartNoAxesColumnIncreasing aria-hidden="true" /></summary>
    <div className="workspaceComposerPickerPanel is-thinking" aria-label="选择思考力度">
      <small>思考力度</small>
      {modes.map((mode) => <button type="button" aria-pressed={value === mode} key={mode} onClick={(event) => { onChange(mode); closeComposerPicker(event); }}><span>{thinkingModeLabel(mode)}</span>{value === mode ? <Check aria-hidden="true" /> : null}</button>)}
    </div>
  </details>;
}

function ComposerModelPicker({ groups, model, value, onChange, disabled }) {
  return <details className="workspaceComposerPicker workspaceComposerModel" onBlur={closeComposerPickerOnBlur} onKeyDown={closeComposerPickerOnEscape}>
    <summary
      role="button"
      aria-label="AI 模型"
      aria-disabled={disabled}
      aria-haspopup="menu"
      onClick={(event) => disabled && event.preventDefault()}
    ><span>{model?.displayName || (groups.length ? "选择模型" : "未配置")}</span><ChevronDown aria-hidden="true" /></summary>
    <div className="workspaceComposerPickerPanel is-model" aria-label="选择 AI 模型">
      {groups.map((group) => <section key={group.provider}>
        <small>{group.label}</small>
        {group.models.map((option) => <button type="button" aria-pressed={value === option.id} key={option.id} onClick={(event) => { onChange(option.id); closeComposerPicker(event); }}><span>{option.displayName}</span>{value === option.id ? <Check aria-hidden="true" /> : null}</button>)}
      </section>)}
    </div>
  </details>;
}

function ConnectedWorkspaceContextPanel({ panel, browserWidthPx, onBrowserWidthChange, onClose, onReturn }) {
  return (
    <WorkspaceContextPanel
      panel={panel}
      browserWidthPx={browserWidthPx}
      onBrowserWidthChange={onBrowserWidthChange}
      onClose={onClose}
      onReturn={onReturn}
    />
  );
}

export function AppPageContent({ agentId, workspaceDraft, location, modelsVersion, onSessionAccepted }) {
  const { user } = useRouteLoaderData("authenticated");
  const { workspace, agents } = useRouteLoaderData("workspace");
  const navigate = useNavigate();
  const searchParams = new URLSearchParams(location.search);
  const requestedSessionId = searchParams.get("sessionId") || "";
  const requestedProjectId = searchParams.get("projectId") || "";
  const requestedPrompt = searchParams.get("prompt") || "";
  const startFresh = searchParams.get("new") === "1";
  const activeAgent = agents.find((agent) => agent.id === agentId);
  if (!activeAgent) throw new Error("agent_not_found");
  const requestScopeKey = JSON.stringify([workspace.id, activeAgent.id, workspaceDraft, requestedSessionId, startFresh, requestedProjectId]);
  const requestScopeRef = useRef({ key: requestScopeKey, active: true });
  if (requestScopeRef.current.key !== requestScopeKey) requestScopeRef.current = { key: requestScopeKey, active: true };
  const streamAbortRef = useRef(null);
  const chatControllerRef = useRef(null);
  const acceptedSessionRef = useRef(null);
  const acceptedRouteSessionIdRef = useRef("");
  const chatStoreRef = useRef(null);
  if (!chatStoreRef.current) chatStoreRef.current = createChatViewStore({ onRenderTelemetry: publishChatRenderTelemetry });
  const chatStore = chatStoreRef.current;
  const fileInputRef = useRef(null);
  const composerRef = useRef(null);
  const composerStartRectRef = useRef(null);
  const [models, setModels] = useState([]);
  const [modelId, setModelId] = useState("");
  const [thinkingMode, setThinkingMode] = useState("");
  const [sessions, setSessions] = useState([]);
  const [projects, setProjects] = useState([]);
  const [sessionId, setSessionId] = useState("");
  const [assets, setAssets] = useState([]);
  const [pendingAttachmentIds, setPendingAttachmentIds] = useState([]);
  const [pendingUploadFiles, setPendingUploadFiles] = useState([]);
  const [draft, setDraft] = useState("");
  const enterStartsNewLine = useEnterStartsNewLine(user.id);
  const [editingTail, setEditingTail] = useState(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState(null);
  const [deletingSessionId, setDeletingSessionId] = useState("");
  const [deleteConfirmationSessionId, setDeleteConfirmationSessionId] = useState("");
  const [editingSessionId, setEditingSessionId] = useState("");
  const [savingSessionId, setSavingSessionId] = useState("");
  const [openSessionMenuId, setOpenSessionMenuId] = useState("");
  const [cancellingAgentRunId, setCancellingRunId] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(!workspaceDraft);
  const [historyCursor, setHistoryCursor] = useState(null);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);
  const [contextPanel, setContextPanel] = useState(CLOSED_CONTEXT_PANEL);
  const [browserPanelWidthPx, setBrowserPanelWidthPx] = useState(760);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const attachmentDialogRef = useModalDialog({ open: Boolean(attachmentPreview), onClose: () => setAttachmentPreview(null) });
  const previewRequestIdRef = useRef(0);
  const activeSessionIdRef = useRef(sessionId);
  activeSessionIdRef.current = sessionId;

  const agentRunList = useAgentRunList(chatStore);
  const currentModel = useMemo(() => models.find((model) => model.id === modelId), [models, modelId]);
  const modelGroups = useMemo(() => {
    const groups = new Map();
    models.forEach((model) => {
      const provider = model.providerId || "builtin";
      const providerModels = groups.get(provider) || [];
      providerModels.push(model);
      groups.set(provider, providerModels);
    });
    return [...groups].map(([provider, providerModels]) => ({
      provider,
      label: providerModels[0].providerDisplayName || "模型",
      models: providerModels,
    }));
  }, [models]);
  useEffect(() => {
    setThinkingMode(currentModel?.thinkingMode || "");
  }, [currentModel?.id, currentModel?.thinkingMode]);
  const hasActiveAgentRun = agentRunList.hasActiveAgentRun;
  const activeAgentRunId = [...agentRunList.agentRunIds].reverse().find((agentRunId) => isAgentRunActive(chatStore.getAgentRunSnapshot(agentRunId))) || "";
  const pendingAttachments = useMemo(
    () => pendingAttachmentIds
      .map((id) => assets.find((link) => link.id === id))
      .filter(Boolean),
    [assets, pendingAttachmentIds],
  );
  const latestAgentRun = agentRunList.agentRunIds.length ? chatStore.getAgentRunSnapshot(agentRunList.agentRunIds.at(-1)) : null;
  const activeSession = sessions.find((candidate) => candidate.id === sessionId);
  const latestUserMessage = latestAgentRun?.messages?.findLast((message) => message.role === "user") || null;
  const editableMessageId = !hasActiveAgentRun
    && latestAgentRun
    && latestUserMessage
    && latestUserMessage.messageId === `message:${latestUserMessage.turnId}:user`
    ? latestUserMessage.messageId
    : "";

  const acceptModels = useCallback((nextModels) => {
    setModels(nextModels);
    setModelId((current) => (
      nextModels.some((model) => model.id === current)
        ? current
        : nextModels[0]?.id || ""
    ));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await apiResponse("/api/models", { signal: controller.signal });
        const data = await response.json();
        if (!controller.signal.aborted) acceptModels(data.models);
      } catch {
        if (!controller.signal.aborted) setError("无法刷新模型列表，请重试。");
      }
    }
    load();
    return () => controller.abort();
  }, [modelsVersion, acceptModels]);

  useEffect(() => {
    if (contextPanel.mode !== "filePreview" || !contextPanel.objectUrl) return undefined;
    return () => URL.revokeObjectURL(contextPanel.objectUrl);
  }, [contextPanel]);

  useEffect(() => {
    if (contextPanel.mode === "closed") return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") clearContextPanel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [contextPanel.mode]);

  useEffect(() => {
    requestScopeRef.current.active = true;
    return () => {
      requestScopeRef.current.active = false;
      streamAbortRef.current?.abort();
      chatControllerRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    if (!startFresh && requestedSessionId && acceptedRouteSessionIdRef.current === requestedSessionId) {
      acceptedRouteSessionIdRef.current = "";
      setLoadingHistory(false);
      return undefined;
    }
    let active = true;
    setLoadingHistory(!workspaceDraft);
    acceptedSessionRef.current = null;
    acceptedRouteSessionIdRef.current = "";
    setSessions([]);
    setSessionId("");
    chatStore.clear();
    setHistoryCursor(null);
    setHasMoreHistory(false);
    setAssets([]);
    setPendingAttachmentIds([]);
    setPendingUploadFiles([]);
    setDraft("");
    setSending(false);
    setEditingTail(null);
    setEditingSessionId("");
    setOpenSessionMenuId("");
    clearContextPanel();
    Promise.all([
      apiResponse(`/api/workspaces/${workspace.id}/sessions?agentId=${encodeURIComponent(activeAgent.id)}`).then((response) => response.json()),
      apiResponse(`/api/workspaces/${workspace.id}/session-projects?agentId=${encodeURIComponent(activeAgent.id)}`).then((response) => response.json()),
    ])
      .then(([data, projectData]) => {
        if (!active) return;
        if (!Array.isArray(data.sessions) || !Array.isArray(projectData.projects)) throw new Error("session_navigation_response_invalid");
        setSessions(data.sessions);
        setProjects(projectData.projects);
        const selectedSession = workspaceDraft || startFresh
          ? null
          : data.sessions.find((session) => session.id === requestedSessionId)
            || data.sessions[0]
            || null;
        const selectedSessionId = selectedSession?.id || "";
        setSessionId(selectedSessionId);
        if (selectedSession?.isUnread) markSessionRead(selectedSession);
        if (!selectedSessionId) setLoadingHistory(false);
      })
      .catch(() => {
        if (!active) return;
        setError("无法读取会话列表，请刷新后重试。");
        setLoadingHistory(false);
      });
    return () => { active = false; };
  }, [workspace.id, workspaceDraft, requestedSessionId, requestedProjectId, startFresh, activeAgent.id]);

  useEffect(() => {
    if (requestedPrompt) setDraft(requestedPrompt);
  }, [requestedPrompt]);

  useEffect(() => {
    if (!startFresh || loadingHistory || !workspace || !modelId) return;
    window.requestAnimationFrame(() => document.getElementById("messageDraft")?.focus());
  }, [loadingHistory, modelId, startFresh, workspace]);

  useEffect(() => {
    setEditingTail(null);
    if (!sessionId) {
      chatStore.clear();
      setHistoryCursor(null);
      setHasMoreHistory(false);
      setAssets([]);
      setPendingAttachmentIds([]);
      setPendingUploadFiles([]);
      setEditingTail(null);
      return;
    }
    const acceptedSession = acceptedSessionRef.current;
    if (acceptedSession?.sessionId === sessionId) {
      acceptedSessionRef.current = null;
      const controller = new AbortController();
      streamAbortRef.current = controller;
      setHistoryCursor(null);
      setHasMoreHistory(false);
      setLoadingHistory(false);
      apiResponse(`/api/sessions/${sessionId}/assets`)
        .then((response) => response.json())
        .then((data) => {
          if (activeSessionIdRef.current === sessionId) setAssets(data.assets);
        })
        .catch(() => {
          if (activeSessionIdRef.current === sessionId) setError("无法刷新会话材料");
        });
      connectAgentRun(acceptedSession.agentRunId, workspace.id, sessionId, controller).catch((streamError) => {
        handleAgentRunStreamFailure(streamError, acceptedSession.agentRunId);
      });
      return () => {
        controller.abort();
        chatControllerRef.current?.dispose();
      };
    }
    streamAbortRef.current?.abort();
    chatControllerRef.current?.dispose();
    const controller = new AbortController();
    streamAbortRef.current = controller;
    let active = true;
    setLoadingHistory(true);
    setError("");
    Promise.all([apiResponse(`/api/sessions/${sessionId}/history?limit=40`), apiResponse(`/api/sessions/${sessionId}/assets`)])
      .then(async ([historyResponse, assetsResponse]) => {
        const history = validateHistoryPage(await historyResponse.json(), { sessionId, workspaceId: workspace.id });
        const assetData = await assetsResponse.json();
        if (!active) return;
        chatStore.replaceAll(history.agentRuns);
        setHistoryCursor(history.nextCursor);
        setHasMoreHistory(history.hasMore);
        setAssets(assetData.assets);
        setPendingAttachmentIds([]);
        setPendingUploadFiles([]);
        const runningAgentRun = [...history.agentRuns].reverse().find((agentRun) => ["queued", "running"].includes(agentRun.status) && !agentRun.projectionError);
        if (runningAgentRun) {
          connectAgentRun(runningAgentRun.id, workspace.id, sessionId, controller, {
            cursor: runningAgentRun.streamCursor,
          }).catch((streamError) => {
            handleAgentRunStreamFailure(streamError, runningAgentRun.id);
          });
        }
      })
      .catch(() => active && setError("无法读取会话记录，请刷新后重试。"))
      .finally(() => active && setLoadingHistory(false));
    return () => {
      active = false;
      controller.abort();
      chatControllerRef.current?.dispose();
    };
  }, [sessionId, workspace?.id]);

  function showStreamError(errorValue) {
    if (errorValue?.name === "AbortError") return;
    setError("操作未完成，请重试。");
  }

  function handleAgentRunStreamFailure(errorValue, agentRunId) {
    if (errorValue?.name === "AbortError") return;
    chatStore.markAgentRunProjectionError(agentRunId);
  }

  async function refreshAgentRunResumeState(agentRunId, targetWorkspaceId, targetSessionId) {
    const response = await apiResponse(`/api/sessions/${targetSessionId}/history?limit=40`);
    const history = validateHistoryPage(await response.json(), {
      sessionId: targetSessionId,
      workspaceId: targetWorkspaceId,
    });
    const resumedAgentRun = history.agentRuns.find((item) => item.id === agentRunId);
    if (!resumedAgentRun) throw new Error("active AgentRun is missing from Session history");
    chatStore.replaceAgentRun(resumedAgentRun);
    return resumedAgentRun;
  }

  async function retryAgentRunProjection(agentRunId) {
    if (!sessionId) return;
    setError("");
    try {
      const resumed = await refreshAgentRunResumeState(agentRunId, workspace.id, sessionId);
      if (resumed.projectionError || !["queued", "running"].includes(resumed.status)) return;
      streamAbortRef.current?.abort();
      chatControllerRef.current?.dispose();
      const controller = new AbortController();
      streamAbortRef.current = controller;
      connectAgentRun(agentRunId, workspace.id, sessionId, controller, {
        cursor: resumed.streamCursor,
      }).catch((streamError) => handleAgentRunStreamFailure(streamError, agentRunId));
    } catch {
      chatStore.markAgentRunProjectionError(agentRunId);
    }
  }

  async function refreshSessions(targetWorkspaceId) {
    const response = await apiResponse(`/api/workspaces/${targetWorkspaceId}/sessions?agentId=${encodeURIComponent(activeAgent.id)}`);
    const data = await response.json();
    setSessions(data.sessions);
    return data.sessions;
  }

  async function updateSession(targetSessionId, metadata) {
    if (savingSessionId) return null;
    setSavingSessionId(targetSessionId);
    try {
      const response = await apiResponse(`/api/sessions/${targetSessionId}`, {
        method: "PATCH",
        body: JSON.stringify(metadata),
      });
      const data = await response.json();
      if (!data?.session || data.session.id !== targetSessionId) throw new Error("session_metadata_response_invalid");
      setSessions((items) => sortSessions(items.map((item) => (item.id === targetSessionId ? data.session : item))));
      return data.session;
    } finally {
      setSavingSessionId("");
    }
  }

  function markSessionRead(session) {
    if (!session.isUnread) return;
    updateSession(session.id, { isUnread: false }).catch(() => setError("无法更新会话未读状态"));
  }

  async function connectAgentRun(agentRunId, targetWorkspaceId, targetSessionId, abortController, resume = {}) {
    chatControllerRef.current?.dispose();
    const controller = new WorkspaceChatController({
      store: chatStore,
      workspaceId: targetWorkspaceId,
      sessionId: targetSessionId,
      agentRunId,
      initialCursor: resume.cursor || "0-0",
    });
    chatControllerRef.current = controller;
    let streamCompleted = false;
    try {
      await streamWorkspaceAgentRun({
        controller,
        signal: abortController.signal,
        onConnection: (connection) => chatStore.updateConnection(agentRunId, connection),
        refreshResumeState: () => refreshAgentRunResumeState(agentRunId, targetWorkspaceId, targetSessionId),
      });
      streamCompleted = true;
    } finally {
      try {
        await controller.whenIdle();
        const agentRun = chatStore.getAgentRunSnapshot(agentRunId);
        if (streamCompleted && agentRun && !isAgentRunActive(agentRun)) {
          try {
            const nextSessions = await refreshSessions(targetWorkspaceId);
            const current = nextSessions.find((item) => item.id === targetSessionId);
            if (activeSessionIdRef.current === targetSessionId && current?.isUnread) {
              await updateSession(targetSessionId, { isUnread: false });
            }
          } catch {
            setError("无法刷新会话列表");
          }
        }
      } finally {
        if (chatControllerRef.current === controller) chatControllerRef.current = null;
        controller.dispose();
      }
    }
  }

  function startNewChat(projectId = "") {
    if (sending) return;
    acceptedSessionRef.current = null;
    acceptedRouteSessionIdRef.current = "";
    streamAbortRef.current?.abort();
    chatControllerRef.current?.dispose();
    setSessionId("");
    setLoadingHistory(false);
    chatStore.clear();
    setHistoryCursor(null);
    setHasMoreHistory(false);
    setAssets([]);
    setPendingAttachmentIds([]);
    setPendingUploadFiles([]);
    setEditingTail(null);
    setDraft("");
    setError("");
    setEditingSessionId("");
    setOpenSessionMenuId("");
    clearContextPanel();
    const newSessionSearch = new URLSearchParams({ new: "1" });
    if (projectId) newSessionSearch.set("projectId", projectId);
    navigate(workspaceDraft
      ? `/w/${encodeURIComponent(workspace.id)}/app`
      : `/w/${encodeURIComponent(workspace.id)}/agents/${encodeURIComponent(activeAgent.id)}?${newSessionSearch}`);
  }

  function selectSession(session) {
    acceptedRouteSessionIdRef.current = "";
    setPendingUploadFiles([]);
    setEditingTail(null);
    setEditingSessionId("");
    setOpenSessionMenuId("");
    clearContextPanel();
    navigate(`/w/${encodeURIComponent(workspace.id)}/agents/${encodeURIComponent(activeAgent.id)}?sessionId=${encodeURIComponent(session.id)}`);
  }

  async function renameSession(session, rawTitle) {
    const title = rawTitle.trim();
    setEditingSessionId("");
    if (!title || title === session.title || savingSessionId) return;
    try {
      await updateSession(session.id, { title });
    } catch {
      setError("无法重命名会话，请重试。");
    }
  }

  async function createProject(name) {
    const response = await apiResponse(`/api/workspaces/${workspace.id}/session-projects`, {
      method: "POST",
      body: JSON.stringify({ agentId: activeAgent.id, name }),
    });
    const data = await response.json();
    if (
      !data?.project
      || data.project.workspaceId !== workspace.id
      || data.project.agentId !== activeAgent.id
    ) throw new Error("session_project_response_invalid");
    setProjects((items) => [...items, data.project]);
    return data.project;
  }

  async function deleteSession(targetSessionId) {
    if (deletingSessionId) return;
    setDeletingSessionId(targetSessionId);
    setError("");
    try {
      await apiResponse(`/api/sessions/${targetSessionId}`, {
        method: "DELETE",
      });
      const remainingSessions = sessions.filter((session) => session.id !== targetSessionId);
      setSessions(remainingSessions);
      setDeleteConfirmationSessionId("");
      setEditingSessionId("");
      setOpenSessionMenuId("");
      if (targetSessionId === sessionId) {
        acceptedSessionRef.current = null;
        acceptedRouteSessionIdRef.current = "";
        chatStore.clear();
        setHistoryCursor(null);
        setHasMoreHistory(false);
        setAssets([]);
        setPendingAttachmentIds([]);
        setPendingUploadFiles([]);
        setDraft("");
        setLoadingHistory(true);
        const next = remainingSessions[0];
        navigate(next
          ? `/w/${encodeURIComponent(workspace.id)}/agents/${encodeURIComponent(activeAgent.id)}?sessionId=${encodeURIComponent(next.id)}`
          : `/w/${encodeURIComponent(workspace.id)}/agents/${encodeURIComponent(activeAgent.id)}?new=1`);
        if (!next) setLoadingHistory(false);
        clearContextPanel();
      }
    } catch {
      setError("无法删除此对话，请重试。");
    } finally {
      setDeletingSessionId("");
    }
  }

  async function cancelActiveAgentRun() {
    if (!sessionId || !activeAgentRunId || cancellingAgentRunId) return;
    const targetSessionId = sessionId;
    const targetAgentRunId = activeAgentRunId;
    setCancellingRunId(targetAgentRunId);
    setError("");
    try {
      const response = await apiResponse(`/api/sessions/${targetSessionId}/agent-runs/${targetAgentRunId}/cancel`, {
        method: "POST",
      });
      const result = await response.json();
      if (
        result.agentRunId !== targetAgentRunId
        || !["requested", "terminal"].includes(result.disposition)
        || !["queued", "running", "completed", "failed", "cancelled"].includes(result.status)
      ) {
        throw new Error("AgentRun cancellation response is invalid");
      }
      if (result.disposition === "terminal" && activeSessionIdRef.current === targetSessionId) {
        await refreshAgentRunResumeState(targetAgentRunId, workspace.id, targetSessionId);
      }
    } catch (requestError) {
      setError(requestError?.message === "agent_run_cancel_unavailable" ? "运行暂时无法停止，请稍后重试" : "停止运行失败");
    } finally {
      setCancellingRunId("");
    }
  }

  async function sendMessage(event, inlineEdit = null) {
    event?.preventDefault();
    const text = (inlineEdit?.text ?? draft).trim();
    if (!workspace || !text || sending || loadingHistory) return;
    const requestScope = requestScopeRef.current;
    const isCurrentRequest = () => requestScope.active && requestScopeRef.current === requestScope;
    if (hasActiveAgentRun) {
      if (!sessionId || !activeAgentRunId) return;
      if (pendingAttachmentIds.length || pendingUploadFiles.length) {
        setError("补充输入暂不支持附件，请先移除材料");
        return;
      }
      setSending(true);
      setError("");
      const supplementId = crypto.randomUUID();
      try {
        const response = await apiResponse(`/api/sessions/${sessionId}/agent-runs/${activeAgentRunId}/supplements`, {
          method: "POST",
          body: JSON.stringify({ supplementId, message: text }),
        });
        const result = await response.json();
        if (!isCurrentRequest()) return;
        if (
          !result
          || typeof result !== "object"
          || Object.keys(result).sort().join("|") !== "agentRunId|disposition|queuedCount|sessionId|supplementId"
          || result.agentRunId !== activeAgentRunId
          || result.sessionId !== sessionId
          || result.supplementId !== supplementId
          || !["accepted", "duplicate"].includes(result.disposition)
          || !Number.isInteger(result.queuedCount)
          || result.queuedCount < 0
          || result.queuedCount > 8
        ) {
          throw new Error("AgentRun supplement response is invalid");
        }
        setDraft("");
      } catch (requestError) {
        if (isCurrentRequest()) setError(requestError?.message === "agent_run_supplement_unavailable" ? "补充输入暂时无法投递，请稍后重试" : "补充输入失败");
      } finally {
        if (isCurrentRequest()) setSending(false);
      }
      return;
    }
    if (!modelId) return;
    setSending(true);
    const targetSessionId = sessionId || "new";
    const pendingId = `pending:${Date.now()}`;
    const pendingTurnId = `${pendingId}:turn`;
    const replacedAgentRun = inlineEdit ? chatStore.getAgentRunSnapshot(inlineEdit.agentRunId) : null;
    if (inlineEdit && !replacedAgentRun) {
      setError("要编辑的上一轮已不存在，请刷新后重试");
      setSending(false);
      return;
    }
    const attachmentRefs = inlineEdit
      ? inlineEdit.attachments.map((attachment) => attachment.inputRef).sort()
      : [...pendingAttachmentIds].sort();
    const uploadFiles = inlineEdit ? [] : pendingUploadFiles;
    const messageAttachments = inlineEdit ? inlineEdit.attachments : [
      ...pendingAttachments.map((link) => ({
        inputRef: link.id,
        displayName: link.displayName,
        contentType: link.contentType,
      })),
      ...uploadFiles.map((file, index) => ({
        inputRef: `${pendingId}:upload:${index}`,
        displayName: file.name,
        contentType: file.type || "application/octet-stream",
      })),
    ];
    setError("");
    const optimisticAgentRun = {
      id: pendingId,
      status: "queued",
      connection: "starting",
      model: currentModel,
      messages: [{ messageId: `message:${pendingTurnId}:user`, turnId: pendingTurnId, sequence: 0, role: "user", phase: "user", status: "done", text, createdAtMs: Date.now(), attachments: messageAttachments, artifacts: [], entryMotion: targetSessionId === "new" ? "conversation" : "" }],
      activities: [],
      citations: [],
      startedAtMs: Date.now(),
      finishedAtMs: null,
    };
    if (targetSessionId === "new") composerStartRectRef.current = composerRef.current?.getBoundingClientRect() || null;
    if (replacedAgentRun) chatStore.replaceAgentRunId(replacedAgentRun.id, optimisticAgentRun);
    else chatStore.appendAgentRun(optimisticAgentRun);
    try {
      let body;
      if (targetSessionId === "new" && uploadFiles.length) {
        body = new FormData();
        body.append("text", text);
        body.append("modelConfigRef", modelId);
        body.append("agentId", activeAgent.id);
        if (requestedProjectId) body.append("projectId", requestedProjectId);
        if (thinkingMode) body.append("thinkingMode", thinkingMode);
        uploadFiles.forEach((file) => body.append("files", file));
      } else {
        body = JSON.stringify({
          text,
          agentId: activeAgent.id,
          ...(targetSessionId === "new" && requestedProjectId ? { projectId: requestedProjectId } : {}),
          modelConfigRef: modelId,
          ...(thinkingMode ? { thinkingMode } : {}),
          attachmentRefs,
          ...(inlineEdit ? { tailAction: {
            type: "rewriteLastUser",
            targetMessageId: inlineEdit.targetMessageId,
            expectedTailMessageId: inlineEdit.expectedTailMessageId,
          } } : {}),
        });
      }
      const messageResponse = await apiResponse(`/api/workspaces/${workspace.id}/sessions/${targetSessionId}/messages`, {
        method: "POST",
        body,
      });
      const messageData = await messageResponse.json();
      // Navigation invalidates only this UI result, never the server's accepted work.
      if (!isCurrentRequest()) return;
      if (
        typeof messageData?.agentRunId !== "string"
        || !messageData.agentRunId
        || typeof messageData.turnId !== "string"
        || !messageData.turnId
        || messageData.turnId === messageData.agentRunId
        || messageData.session?.agentId !== activeAgent.id
        || (targetSessionId === "new" && (messageData.session?.projectId || "") !== requestedProjectId)
      ) {
        throw new Error("AgentRun acceptance identity is invalid");
      }
      const resolvedSessionId = messageData.sessionId;
      const pendingAgentRun = chatStore.getAgentRunSnapshot(pendingId);
      if (!pendingAgentRun) throw new Error("pending AgentRun disappeared before acceptance");
      if (!inlineEdit) {
        setDraft("");
        setPendingAttachmentIds([]);
        setPendingUploadFiles([]);
      }
      setEditingTail(null);
      chatStore.replaceAgentRunId(pendingId, {
        ...pendingAgentRun,
        id: messageData.agentRunId,
        workspaceId: workspace.id,
        sessionId: resolvedSessionId,
        events: [],
        eventIds: [],
        live: null,
        streamCursor: "0-0",
        messages: pendingAgentRun.messages.map((message) => ({
          ...message,
          messageId: `message:${messageData.turnId}:user`,
          turnId: messageData.turnId,
        })),
      });
      setSessions((items) =>
        sortSessions(
          sessionId
            ? items.map((session) => (session.id === resolvedSessionId ? messageData.session : session))
            : [messageData.session, ...items],
        ),
      );
      if (!sessionId) {
        acceptedSessionRef.current = { sessionId: resolvedSessionId, agentRunId: messageData.agentRunId };
        acceptedRouteSessionIdRef.current = resolvedSessionId;
        setSessionId(resolvedSessionId);
        setSending(false);
        onSessionAccepted(`/w/${encodeURIComponent(workspace.id)}/agents/${encodeURIComponent(activeAgent.id)}?sessionId=${encodeURIComponent(resolvedSessionId)}`);
      } else {
        const controller = new AbortController();
        streamAbortRef.current = controller;
        connectAgentRun(messageData.agentRunId, workspace.id, resolvedSessionId, controller).catch((streamError) => {
          handleAgentRunStreamFailure(streamError, messageData.agentRunId);
        });
      }
    } catch (errorValue) {
      if (!isCurrentRequest()) return;
      if (replacedAgentRun && chatStore.getAgentRunSnapshot(pendingId)) chatStore.replaceAgentRunId(pendingId, replacedAgentRun);
      else chatStore.rejectPendingAgentRun(pendingId);
      showStreamError(errorValue);
    } finally {
      if (isCurrentRequest()) setSending(false);
    }
  }

  function startEditingMessage(message) {
    const expectedTail = latestAgentRun?.messages?.filter((item) => item.role === "user" || item.phase === "final").at(-1);
    if (!latestAgentRun || message.messageId !== editableMessageId || !expectedTail) return;
    setEditingTail({
      agentRunId: latestAgentRun.id,
      targetMessageId: message.messageId,
      expectedTailMessageId: expectedTail.messageId,
      text: message.text,
      attachments: message.attachments || [],
    });
  }

  function cancelEditingMessage() {
    setEditingTail(null);
  }

  async function loadOlderHistory() {
    if (!sessionId || !hasMoreHistory || !historyCursor || loadingOlderHistory) return;
    const requestedForSessionId = sessionId;
    setLoadingOlderHistory(true);
    try {
      const response = await apiResponse(
        `/api/sessions/${sessionId}/history?limit=40&before=${encodeURIComponent(historyCursor)}`,
      );
      const page = validateHistoryPage(await response.json(), { sessionId, workspaceId: workspace.id });
      if (activeSessionIdRef.current !== requestedForSessionId) return;
      chatStore.prependAgentRuns(page.agentRuns);
      setHistoryCursor(page.nextCursor);
      setHasMoreHistory(page.hasMore);
    } catch {
      setError("无法读取更早的会话内容，请重试。");
    } finally {
      if (activeSessionIdRef.current === requestedForSessionId) setLoadingOlderHistory(false);
    }
  }

  async function uploadAttachment(event) {
    const input = event.currentTarget;
    const files = Array.from(input.files || []);
    if (!files.length || uploadingAttachment) return;
    if (files.length + pendingUploadFiles.length > MAX_UPLOAD_BATCH_FILES) {
      input.value = "";
      setError(`一次最多添加 ${MAX_UPLOAD_BATCH_FILES} 份材料`);
      return;
    }
    if (!sessionId) {
      setError("");
      setPendingUploadFiles((items) => [...items, ...files]);
      input.value = "";
      return;
    }
    const uploadSessionId = sessionId;
    const body = new FormData();
    files.forEach((file) => body.append("files", file));
    setError("");
    setUploadingAttachment(true);
    try {
      const response = await apiResponse(`/api/sessions/${sessionId}/uploads`, { method: "POST", body });
      const uploaded = await response.json();
      if (
        !Array.isArray(uploaded.libraryObjects)
        || !Array.isArray(uploaded.assets)
        || uploaded.libraryObjects.length !== files.length
        || uploaded.assets.length !== files.length
        || uploaded.assets.some((asset, index) => (
          !asset?.id
          || !uploaded.libraryObjects[index]?.id
          || asset.asset?.id !== uploaded.libraryObjects[index].id
          || asset.assetKind !== "userLibraryObject"
          || asset.displayName !== files[index].name
          || uploaded.libraryObjects[index].displayName !== files[index].name
        ))
        || new Set(uploaded.assets.map((asset) => asset.id)).size !== files.length
      ) {
        throw new Error("attachment_upload_response_invalid");
      }
      if (activeSessionIdRef.current !== uploadSessionId) return;
      setAssets((items) => uploaded.assets.reduce(
        (current, asset) => upsertBy(current, "id", asset),
        items,
      ));
      setPendingAttachmentIds((items) => [
        ...new Set([...items, ...uploaded.assets.map((asset) => asset.id)]),
      ]);
    } catch {
      setError("附件上传失败");
    } finally {
      input.value = "";
      setUploadingAttachment(false);
    }
  }

  function removePendingAttachment(link) {
    setPendingAttachmentIds((items) => items.filter((id) => id !== link.id));
    if (attachmentPreview?.id === link.id) setAttachmentPreview(null);
  }

  function removePendingUploadFile(index) {
    setPendingUploadFiles((items) => items.filter((_file, itemIndex) => itemIndex !== index));
  }

  function closeContextPanel() {
    clearContextPanel();
  }

  function clearContextPanel() {
    previewRequestIdRef.current += 1;
    setContextPanel(CLOSED_CONTEXT_PANEL);
  }

  function returnFromFilePreview() {
    if (contextPanel.mode !== "filePreview") return;
    const { origin } = contextPanel;
    previewRequestIdRef.current += 1;
    setContextPanel(CLOSED_CONTEXT_PANEL);
    window.requestAnimationFrame(() => {
      document.getElementById(origin.elementId)?.focus({ preventScroll: true });
    });
  }

  async function showCitation(citation, origin) {
    const requestId = previewRequestIdRef.current + 1;
    previewRequestIdRef.current = requestId;
    setError("");
    setContextPanel({
      mode: "filePreview",
      citationId: citation.citationId,
      displayName: citation.displayName,
      origin,
      status: "loading",
    });
    try {
      const response = await apiResponse(citation.sourceUrl);
      const detail = (await response.json()).citation;
      const previewResponse = await apiResponse(detail.previewUrl);
      const contentType = (previewResponse.headers.get("Content-Type") || "").split(";", 1)[0].trim().toLowerCase();
      let preview;
      if (contentType === "text/plain" || contentType === "text/markdown") {
        preview = { kind: "text", content: await previewResponse.text(), objectUrl: "" };
      } else if (contentType === "application/pdf") {
        const objectUrl = URL.createObjectURL(await previewResponse.blob());
        const pageNumber = Number.isInteger(detail.locator?.page)
          ? detail.locator.page
          : Number.isInteger(detail.locator?.pageStart)
            ? detail.locator.pageStart
            : null;
        const page = pageNumber ? `#page=${pageNumber}` : "";
        preview = { kind: "pdf", objectUrl, src: `${objectUrl}${page}` };
      } else if (contentType.startsWith("image/")) {
        const objectUrl = URL.createObjectURL(await previewResponse.blob());
        preview = { kind: "image", objectUrl, src: objectUrl };
      } else {
        throw new Error(`unsupported citation preview content type: ${contentType || "missing"}`);
      }
      if (previewRequestIdRef.current !== requestId) {
        if (preview.objectUrl) URL.revokeObjectURL(preview.objectUrl);
        return;
      }
      setContextPanel({
        mode: "filePreview",
        citationId: citation.citationId,
        origin,
        status: "ready",
        ...detail,
        preview,
        objectUrl: preview.objectUrl || "",
      });
    } catch (requestError) {
      if (previewRequestIdRef.current !== requestId) return;
      const reason = requestError instanceof Error ? requestError.message : String(requestError);
      const message = reason === "citation_preview_unsupported"
        ? "此文件类型暂不支持内嵌预览。"
        : reason === "citation_source_stale"
          ? "引用绑定的文件版本已经变化，无法预览原始证据。"
          : reason === "citation_source_not_available" || reason === "citation_not_found"
            ? "引用文件不存在、已删除或当前无权读取。"
            : "无法读取引用文件。";
      setContextPanel({
        mode: "filePreview",
        citationId: citation.citationId,
        displayName: citation.displayName,
        origin,
        status: "error",
        error: message,
      });
    }
  }

  async function showArtifact(artifact, origin) {
    const requestId = previewRequestIdRef.current + 1;
    previewRequestIdRef.current = requestId;
    setError("");
    setContextPanel({
      mode: "filePreview",
      artifactRef: artifact.artifactRef,
      displayName: artifact.filename,
      downloadUrl: artifact.downloadUrl,
      origin,
      originLabel: "Artifact",
      status: "loading",
    });
    try {
      const previewResponse = await apiResponse(artifact.downloadUrl);
      const contentType = (previewResponse.headers.get("Content-Type") || "").split(";", 1)[0].trim().toLowerCase();
      const contentLength = Number(previewResponse.headers.get("Content-Length") || "");
      let preview;
      const previewable = !Number.isNaN(contentLength) && contentLength > 0 && contentLength <= ARTIFACT_PREVIEW_MAX_BYTES;
      if (previewable && ARTIFACT_PREVIEW_CONTENT_TYPES.has(contentType)) {
        if (contentType === "text/plain" || contentType === "text/markdown") {
          preview = { kind: "text", content: await previewResponse.text(), objectUrl: "" };
        } else if (contentType === "application/pdf") {
          const objectUrl = URL.createObjectURL(await previewResponse.blob());
          preview = { kind: "pdf", objectUrl, src: objectUrl };
        } else {
          const objectUrl = URL.createObjectURL(await previewResponse.blob());
          preview = { kind: "image", objectUrl, src: objectUrl };
        }
      } else {
        preview = { kind: "unsupported", objectUrl: "" };
      }
      if (previewRequestIdRef.current !== requestId) {
        if (preview.objectUrl) URL.revokeObjectURL(preview.objectUrl);
        return;
      }
      setContextPanel({
        mode: "filePreview",
        artifactRef: artifact.artifactRef,
        displayName: artifact.filename,
        downloadUrl: artifact.downloadUrl,
        origin,
        originLabel: "Artifact",
        status: "ready",
        preview,
        objectUrl: preview.objectUrl || "",
      });
    } catch (requestError) {
      if (previewRequestIdRef.current !== requestId) return;
      setContextPanel({
        mode: "filePreview",
        artifactRef: artifact.artifactRef,
        displayName: artifact.filename,
        downloadUrl: artifact.downloadUrl,
        origin,
        originLabel: "Artifact",
        status: "error",
        error: "无法读取该文件。",
      });
    }
  }

  const hasContextPanel = contextPanel.mode !== "closed";
  const contextPanelClass = hasContextPanel ? "withContextPanel withFilePreview" : "";
  const isHome = !requestedSessionId && !sessionId && agentRunList.agentRunIds.length === 0;
  useLayoutEffect(() => {
    const startRect = composerStartRectRef.current;
    if (isHome || !startRect) return;
    composerStartRectRef.current = null;
    const composer = composerRef.current;
    if (!composer || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const endRect = composer.getBoundingClientRect();
    composer.animate([
      { transform: `translate(${startRect.left - endRect.left}px, ${startRect.top - endRect.top}px)` },
      { transform: "translate(0, 0)" },
    ], { duration: 320, easing: "cubic-bezier(.2, .8, .2, 1)" });
  }, [isHome]);
  const updateBrowserPanelWidth = useCallback((widthPx) => {
    const maxWidthPx = Math.max(480, Math.floor(window.innerWidth * 0.75));
    setBrowserPanelWidthPx(Math.min(maxWidthPx, Math.max(480, Math.round(widthPx))));
  }, []);
  const groupedSessions = useMemo(() => {
    const grouped = {
      pinned: [],
      recent: [],
      projectSessions: Object.fromEntries(projects.map((project) => [project.id, []])),
      projectionError: false,
    };
    sessions.forEach((session) => {
      if (session.origin !== "user" && session.origin !== "automation") {
        grouped.projectionError = true;
        return;
      }
      if (session.projectId) {
        const projectSessions = grouped.projectSessions[session.projectId];
        if (!projectSessions) {
          grouped.projectionError = true;
          return;
        }
        projectSessions.push(session);
      } else if (session.isPinned) grouped.pinned.push(session);
      else grouped.recent.push(session);
    });
    return grouped;
  }, [projects, sessions]);
  function handleQuickAction(prompt) {
    setDraft(prompt);
    window.requestAnimationFrame(() => {
      document.getElementById("messageDraft")?.focus();
    });
  }

  function renderSessionRow(session, { icon = false, nested = false } = {}) {
    const isEditing = editingSessionId === session.id;
    const isSaving = savingSessionId === session.id;
    if (isEditing) {
      return (
        <form
          className="workspaceSessionRow workspaceSessionEdit"
          key={session.id}
          onSubmit={(event) => {
            event.preventDefault();
            event.currentTarget.elements.title.blur();
          }}
        >
          <input
            name="title"
            aria-label={`重命名 ${session.title}`}
            autoFocus
            defaultValue={session.title}
            maxLength={200}
            disabled={isSaving}
            onBlur={(event) => renameSession(session, event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
              if (event.key === "Escape") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
        </form>
      );
    }
    return (
      <div className={`workspaceSessionRow ${nested ? "isNested" : ""} ${openSessionMenuId === session.id ? "hasOpenMenu" : ""}`} key={session.id}>
        <button
          className={`workspaceSessionButton ${session.id === sessionId ? "isActive" : ""}`}
          aria-current={session.id === sessionId ? "page" : undefined}
          data-testid={session.id === sessionId ? "active-session" : undefined}
          data-session-id={session.id}
          onClick={() => selectSession(session)}
        >
          {icon ? <MessageSquare className="workspaceSessionKindIcon" aria-hidden="true" /> : null}
          <span className="workspaceSessionContent">
            <span className="workspaceSessionTitle"><span>{session.title}</span>{session.isPinned ? <Pin aria-label="已置顶" /> : null}</span>
            <span className="workspaceSessionMetadata">
              {session.origin === "automation" ? <span className="workspaceSessionAutomation">自动</span> : null}
              {session.isUnread ? <span className="workspaceSessionUnread" aria-label="未读" /> : null}
            </span>
          </span>
        </button>
        {(session.id === sessionId ? hasActiveAgentRun : session.hasActiveAgentRun) ? (
          <span className="workspaceAgentRunning" aria-label="运行中"><LoaderCircle aria-hidden="true" /></span>
        ) : null}
        <div className="workspaceSessionActions">
          <button
            className="workspaceSessionActionButton"
            type="button"
            aria-label={`会话操作 ${session.title}`}
            aria-expanded={openSessionMenuId === session.id}
            onClick={() => setOpenSessionMenuId((current) => current === session.id ? "" : session.id)}
          >
            <Ellipsis aria-hidden="true" />
          </button>
          {openSessionMenuId === session.id ? (
            <div className="workspaceSessionMenu" role="menu">
              <button type="button" role="menuitem" onClick={() => {
                setEditingSessionId(session.id);
                setOpenSessionMenuId("");
              }}><Pencil aria-hidden="true" />重命名</button>
              <button type="button" role="menuitem" disabled={isSaving} onClick={() => {
                updateSession(session.id, { isPinned: !session.isPinned }).catch(() => setError("无法更新会话置顶状态"));
                setOpenSessionMenuId("");
              }}>{session.isPinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}{session.isPinned ? "取消置顶" : "置顶"}</button>
              <button type="button" role="menuitem" disabled={isSaving} onClick={() => {
                updateSession(session.id, { isUnread: !session.isUnread }).catch(() => setError("无法更新会话未读状态"));
                setOpenSessionMenuId("");
              }}>{session.isUnread ? <MailOpen aria-hidden="true" /> : <Mail aria-hidden="true" />}{session.isUnread ? "标为已读" : "标为未读"}</button>
              <button className="isDanger" type="button" role="menuitem" disabled={Boolean(deletingSessionId)} onClick={() => {
                setOpenSessionMenuId("");
                setDeleteConfirmationSessionId(session.id);
              }}><Trash2 aria-hidden="true" />删除</button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <main
      className={`workspaceWorkbench ${isSidebarOpen ? "withSidebar" : "withoutSidebar"} ${contextPanelClass}`}
      style={{ "--browser-panel-width": `${browserPanelWidthPx}px` }}
    >
      <div className="workspaceSidebarSlot">
        {isSidebarOpen ? <ShellSidebar
          workspace={workspace}
          agents={agents}
          activeAgent={activeAgent}
          onStartNewChat={startNewChat}
          onCollapse={() => setIsSidebarOpen(false)}
          initialTab={workspaceDraft || location.state?.sidebarTab === "home" ? "home" : "chat"}
          sessionProps={{
            agentId: activeAgent.id,
            sessions,
            projects,
            groupedSessions,
            renderSessionRow,
            onCreateProject: createProject,
          }}
        /> : null}
      </div>

      <header className={`workspaceTopbar ${isHome ? "isHome" : ""}`}>
        <div className="workspaceTopbarStart">
          {!isSidebarOpen ? <button
            className="workspacePanelToggle"
            type="button"
            onClick={() => setIsSidebarOpen(true)}
            aria-label="显示左侧栏"
            aria-expanded="false"
            title="显示左侧栏"
          >
            <PanelLeft aria-hidden="true" />
          </button> : null}
          {isSidebarOpen && activeSession ? <nav className="workspaceConversationBreadcrumb" aria-label="当前会话">
            <AgentMark className="workspaceConversationAgentIcon" agent={activeAgent} />
            <Link to={`/w/${encodeURIComponent(workspace.id)}/agents/${encodeURIComponent(activeAgent.id)}/settings`}>{activeAgent.name}</Link><span>/</span><span>{activeSession.title}</span>
          </nav> : null}
        </div>
      </header>

      <section className="workspaceChatColumn">
        {error || groupedSessions.projectionError ? <div className="errorBanner" role="alert">{error || "部分会话暂时无法显示，请刷新后重试。"}</div> : null}

        <div className={`workspaceConversationPlane ${isHome ? "isEmpty" : ""}`}>
          <VirtualAgentRunList
            store={chatStore}
            sessionId={sessionId}
            loadingHistory={loadingHistory}
            hasMoreHistory={hasMoreHistory}
            loadingOlderHistory={loadingOlderHistory}
            onLoadOlderHistory={loadOlderHistory}
            emptyState={isHome ? <HomePlane agent={activeAgent} /> : null}
            onShowCitation={(agentRunId, citation) => showCitation(citation, {
              mode: "answer",
              agentRunId,
              elementId: `citation:${agentRunId}:${citation.citationId}`,
            })}
            onShowArtifact={(agentRunId, artifact) => showArtifact(artifact, {
              mode: "answer",
              agentRunId,
              elementId: `artifact:${agentRunId}:${artifact.artifactRef}`,
            })}
            assets={assets}
            onShowAttachment={setAttachmentPreview}
            editableMessageId={editableMessageId}
            editingMessageId={editingTail?.targetMessageId || ""}
            editingPrompt={editingTail?.text || ""}
            editingDisabled={sending}
            onStartEditingMessage={startEditingMessage}
            onEditingPromptChange={(text) => setEditingTail((current) => current ? { ...current, text } : current)}
            onCancelEditingMessage={cancelEditingMessage}
            onSubmitEditingMessage={() => void sendMessage(null, editingTail)}
            onRetryAgentRun={retryAgentRunProjection}
          />

          <form ref={composerRef} className={`workspaceComposer ${isHome ? "shComposerHero" : ""}`} onSubmit={sendMessage}>
            {pendingAttachments.length || pendingUploadFiles.length ? (
              <div className="workspaceComposerAttachments" aria-label="本次对话参考材料">
                {pendingAttachments.map((link) => (
                  <AttachmentCard className="workspaceComposerAttachment" attachment={link} onPreview={() => setAttachmentPreview(link)} onRemove={() => removePendingAttachment(link)} key={link.id} />
                ))}
                {pendingUploadFiles.map((file, index) => (
                  <LocalAttachmentCard file={file} onRemove={() => removePendingUploadFile(index)} key={localAttachmentKey(file)} />
                ))}
              </div>
            ) : null}
            <label className="srOnly" htmlFor="messageDraft">输入消息</label>
            <textarea
              id="messageDraft"
              autoFocus={isHome}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                const shouldSend = enterStartsNewLine
                  ? event.metaKey || event.ctrlKey
                  : !event.shiftKey;
                if (shouldSend) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={`描述你希望 ${activeAgent.name} 协助完成的任务…`}
              disabled={!workspace || sending || loadingHistory || !!editingTail}
            />
            <div className="workspaceComposerFooter">
              <div className="workspaceComposerControlGroup">
                <span className="workspaceComposerControl" data-tooltip="添加">
                  <button
                    className="workspaceComposerIconButton"
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={hasActiveAgentRun || sending || uploadingAttachment || !!editingTail}
                    aria-label="添加"
                  >
                    {uploadingAttachment ? <LoaderCircle className="statusIcon" aria-hidden="true" /> : <Plus aria-hidden="true" />}
                  </button>
                </span>
                <span className="workspaceComposerControl isPending" data-tooltip="设置 · 待接入" role="img" aria-label="设置，待接入">
                  <SlidersHorizontal aria-hidden="true" />
                </span>
                <ContextUsagePicker sessionId={sessionId} isRunning={hasActiveAgentRun} />
              </div>
              <input ref={fileInputRef} className="srOnly" type="file" multiple aria-label="选择一个或多个材料" onChange={uploadAttachment} />
              <div className="workspaceComposerControlGroup isRuntime">
                <span className="workspaceComposerControl" data-tooltip={thinkingMode ? `思考力度 · ${thinkingModeLabel(thinkingMode)}` : "思考力度"}>
                  <ComposerThinkingPicker model={currentModel} value={thinkingMode} onChange={setThinkingMode} disabled={!currentModel?.thinkingModes?.length || sending || hasActiveAgentRun || !!editingTail} />
                </span>
                <span className="workspaceComposerControl" data-tooltip={`AI 模型 · ${currentModel?.displayName || (models.length ? "请选择" : "未配置")}`}>
                  <ComposerModelPicker groups={modelGroups} model={currentModel} value={modelId} onChange={setModelId} disabled={!models.length || sending || !!editingTail} />
                </span>
                <span className="workspaceComposerControl" data-tooltip={hasActiveAgentRun ? "停止" : "输入"}>
                  {hasActiveAgentRun ? (
                    <button
                      className="workspaceSendButton"
                      type="button"
                      aria-label="停止"
                      disabled={!activeAgentRunId || Boolean(cancellingAgentRunId)}
                      onClick={cancelActiveAgentRun}
                    >
                      {cancellingAgentRunId ? <LoaderCircle className="statusIcon" aria-hidden="true" /> : <Square aria-hidden="true" />}
                    </button>
                  ) : (
                    <button
                      className="workspaceSendButton"
                      type="submit"
                      aria-label="输入"
                      disabled={!workspace || !draft.trim() || !modelId || sending || loadingHistory || !!editingTail}
                    >
                      {sending ? <LoaderCircle className="statusIcon" aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
                    </button>
                  )}
                </span>
              </div>
            </div>
          </form>
          {isHome ? <HomeQuickActions onQuickAction={handleQuickAction} /> : null}
        </div>
      </section>

      <ConnectedWorkspaceContextPanel
        panel={contextPanel}
        browserWidthPx={browserPanelWidthPx}
        onBrowserWidthChange={updateBrowserPanelWidth}
        onClose={closeContextPanel}
        onReturn={returnFromFilePreview}
      />
      <ConfirmDialog
        open={Boolean(deleteConfirmationSessionId)}
        title="确定要删除此对话？"
        busy={Boolean(deletingSessionId)}
        onCancel={() => setDeleteConfirmationSessionId("")}
        onConfirm={() => void deleteSession(deleteConfirmationSessionId)}
      />
      {attachmentPreview ? (
        <div className="attachmentPreviewBackdrop" role="presentation" onMouseDown={() => setAttachmentPreview(null)}>
          <section className="attachmentPreviewDialog" ref={attachmentDialogRef} role="dialog" aria-modal="true" aria-label={`预览 ${attachmentPreview.displayName}`} tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
            <header><strong>{attachmentPreview.displayName}</strong><button type="button" onClick={() => setAttachmentPreview(null)} aria-label="关闭预览"><X aria-hidden="true" /></button></header>
            {attachmentCanPreview(attachmentPreview) ? attachmentIsImage(attachmentPreview) ? <img src={attachmentPreviewUrl(attachmentPreview)} alt={attachmentPreview.displayName} /> : <iframe src={attachmentPreviewUrl(attachmentPreview)} title={attachmentPreview.displayName} /> : <div className="attachmentPreviewUnavailable"><ImageIcon aria-hidden="true" /><span>此材料暂不支持在线预览。</span><a href={attachmentDownloadUrl(attachmentPreview)}>下载材料</a></div>}
          </section>
        </div>
      ) : null}
    </main>
  );
}
