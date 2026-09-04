import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ChevronDown, Code2, Copy, FileText, Pencil, Search } from "lucide-react";
import { useActivityDisclosures, useAgentRun } from "./chatStoreHooks";
import { isAgentRunActive } from "./sessionEvents";
import { activityTarget, activityToolAtom, buildAgentRunSections, formatPhaseElapsed, referenceCitations, runningActivityPresentation } from "./agentRunPresentation.mjs";
import { MarkdownContent, StreamingMarkdownContent } from "./MarkdownContent";
import { AttachmentCard } from "./AttachmentCard";

const TOOL_ICONS = { agent: Bot, code: Code2, edit: Pencil, file: FileText, search: Search };

function operationLabel(operation) {
  return activityToolAtom(operation.toolName, operation.providerId).title;
}

function DiffPreview({ content }) {
  const lines = content.split("\n");
  return (
    <pre className="activityOperationOutput isDiff"><code>{lines.map((line, index) => {
      const tone = line.startsWith("+") && !line.startsWith("+++")
        ? "isAdded"
        : line.startsWith("-") && !line.startsWith("---")
          ? "isRemoved"
          : line.startsWith("@@")
            ? "isHunk"
            : "";
      return <span className={`activityDiffLine ${tone}`} key={`${index}:${line}`}><span className="activityDiffLineNumber">{index + 1}</span><span>{line || " "}</span></span>;
    })}</code></pre>
  );
}

function ActivityOperation({ operation, expanded, onToggle }) {
  const atom = activityToolAtom(operation.toolName, operation.providerId);
  const Icon = TOOL_ICONS[atom.icon];
  const command = typeof operation.normalizedInput?.command === "string" ? operation.normalizedInput.command : "";
  const description = typeof operation.normalizedInput?.description === "string"
    ? operation.normalizedInput.description.trim()
    : "";
  const path = operation.path || (typeof operation.normalizedInput?.path === "string" ? operation.normalizedInput.path : "");
  const query = operation.query || (typeof operation.normalizedInput?.query === "string" ? operation.normalizedInput.query : "");
  const output = operation.modelContent || operation.outputPreview || "";
  const error = operation.error || "";
  const failed = operation.status === "failed" || ["failed", "denied", "aborted"].includes(operation.resultState);
  const hasDetails = atom.detail === "bash"
    ? Boolean(command || output || error)
    : atom.detail === "diff"
      ? Boolean(operation.diffPreview || error)
      : atom.detail === "file" && Boolean(output || error);
  const Summary = hasDetails ? "button" : "div";
  return (
    <div className={`activityOperation is-${operation.toolName} ${failed ? "isFailed" : ""}`}>
      <Summary className="activityOperationSummary" {...(hasDetails ? { type: "button", onClick: onToggle, "aria-expanded": expanded } : {})}>
        <Icon aria-hidden="true" />
        <span title={description || command || path || query || operationLabel(operation)}>{description || command || path || query || operationLabel(operation)}</span>
        {failed ? <small>Failed</small> : null}
        {hasDetails ? <ChevronDown className={expanded ? "isExpanded" : ""} aria-hidden="true" /> : null}
      </Summary>
      {hasDetails && expanded ? <div className="activityOperationDisclosure isExpanded">
        <div className="activityOperationBody">
          {path || query || Number.isInteger(operation.matchCount) || Number.isInteger(operation.added) || Number.isInteger(operation.removed) || Number.isInteger(operation.lines) || Number.isInteger(operation.startLine) ? (
            <div className="activityOperationMeta">
              {path || operation.target ? <span>{path || operation.target}</span> : null}
              {Number.isInteger(operation.startLine) && Number.isInteger(operation.endLine) && Number.isInteger(operation.totalLines) ? <span>lines {operation.startLine}-{operation.endLine} of {operation.totalLines}</span> : null}
              {query ? <span>Query: {query}</span> : null}
              {Number.isInteger(operation.matchCount) ? <span>{operation.matchCount} results</span> : null}
              {Number.isInteger(operation.added) || Number.isInteger(operation.removed) ? <span>+{operation.added || 0} / -{operation.removed || 0}</span> : null}
              {Number.isInteger(operation.lines) ? <span>{operation.lines} lines</span> : null}
            </div>
          ) : null}
          {atom.detail === "bash" && command ? (
            <div className="activityOperationCommandRow">
              <pre className="activityOperationCommand"><code>$ {command}</code></pre>
              <button type="button" onClick={() => void navigator.clipboard.writeText(command)} aria-label="Copy command" title="Copy command"><Copy aria-hidden="true" /></button>
            </div>
          ) : null}
          {atom.detail === "diff" && operation.diffPreview ? <DiffPreview content={operation.diffPreview} /> : null}
          {atom.detail === "bash" && output ? <pre className="activityOperationOutput"><code>{output}</code></pre> : null}
          {atom.detail === "file" && output ? <pre className="activityOperationOutput"><code>{output}</code></pre> : null}
          {error ? <pre className="activityOperationOutput isError"><code>{error}</code></pre> : null}
          {Number.isInteger(operation.exitCode) || failed ? (
            <div className="activityOperationFooter">
              {Number.isInteger(operation.exitCode) ? <span>Exit {operation.exitCode}</span> : null}
              {failed ? <span>Failed</span> : null}
            </div>
          ) : null}
        </div>
      </div> : null}
    </div>
  );
}

function ActivityGroup({ group, expanded, onToggle, expandedOperations, onToggleOperation }) {
  const operations = group.activities.flatMap((activity) => {
    const common = {
      callId: activity.callId,
      toolName: activity.toolName,
      status: activity.status,
      resultState: activity.result?.resultState,
      normalizedInput: activity.call.normalizedInput,
      displayTarget: activity.call.displayTarget,
      providerId: activity.call.providerId,
      modelContent: activity.result?.modelContent,
    };
    const results = activity.result?.operations?.length
      ? activity.result.operations.map((operation) => ({ ...common, ...operation }))
      : [common];
    return results.map((operation, index) => ({ ...operation, disclosureId: `operation:${activity.callId}:${index}` }));
  });
  const { presentation } = group;
  const Icon = TOOL_ICONS[presentation.icon];
  const hasDetails = presentation.expandable;
  const Header = hasDetails ? "button" : "div";
  return (
    <div className="workspaceActivityGroupRecord">
      <Header className="workspaceActivityGroup" {...(hasDetails ? { type: "button", onClick: onToggle, "aria-expanded": expanded } : {})}>
        <Icon className="workspaceActivityGroupIcon" aria-hidden="true" />
        <span>{presentation.title}</span>
        {hasDetails ? <ChevronDown className={`workspaceActivityGroupChevron ${expanded ? "isExpanded" : ""}`} aria-hidden="true" /> : null}
      </Header>
      {hasDetails && expanded ? <div className="workspaceActivityDetails isExpanded">
        <div className="workspaceActivityDetailsInner">{operations.map((operation) => {
          const operationId = operation.disclosureId;
          return <ActivityOperation operation={operation} expanded={expandedOperations.has(operationId)} onToggle={() => onToggleOperation(operationId)} key={operationId} />;
        })}</div>
      </div> : null}
      {group.activities.some((activity) => activity.toolName === "agent") ? (
        <div className="workspaceAgentTags" aria-label="代理会话">
          {group.activities.filter((activity) => activity.toolName === "agent").map((activity) => (
            <span className={`workspaceAgentTag is-${activity.status}`} key={activity.activityId}>
              <span className="workspaceAgentTagMark" aria-hidden="true" /><strong>代理</strong><span>{activityTarget(activity)}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function formatMessageTime(createdAtMs) {
  if (!Number.isFinite(createdAtMs)) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(createdAtMs));
}

const LiveStatus = memo(function LiveStatus({ Icon, label, startedAtMs }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new phase resets the elapsed clock immediately, before the next interval tick.
  useEffect(() => {
    setNowMs(Date.now());
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [startedAtMs]);
  const elapsed = formatPhaseElapsed(startedAtMs, nowMs);
  return (
    <div className="workspaceLiveStatus">
      {Icon ? <Icon aria-hidden="true" /> : null}
      <span className="workspaceLiveStatusText" aria-live="polite">{label}</span>
      {elapsed ? <>
        <span className="workspaceLiveStatusDivider" aria-hidden="true">·</span>
        <time className="workspaceLiveStatusElapsed" aria-hidden="true">{elapsed}</time>
      </> : null}
    </div>
  );
});

export const AgentRunRow = memo(function AgentRunRow({
  store,
  agentRunId,
  onShowCitation,
  onShowArtifact,
  assets,
  onShowAttachment,
  editableMessageId,
  editingMessageId,
  editingPrompt,
  editingDisabled,
  onStartEditingMessage,
  onEditingPromptChange,
  onCancelEditingMessage,
  onSubmitEditingMessage,
  onRetryAgentRun,
}) {
  const agentRun = useAgentRun(store, agentRunId);
  const hasAgentRun = agentRun !== null;
  const streamRenderRevision = store.getStreamRenderRevision(agentRunId);
  const active = agentRun ? isAgentRunActive(agentRun) : false;
  const expandedActivities = useActivityDisclosures(store, agentRunId);
  const [copiedMessageId, setCopiedMessageId] = useState("");
  const streamedMessageIdsRef = useRef(new Set());
  const assetByInputRef = useMemo(() => new Map((assets || []).map((asset) => [asset.id, asset])), [assets]);
  const sections = useMemo(() => {
    try {
      return buildAgentRunSections(agentRun?.messages || [], agentRun?.activities || []);
    } catch {
      return null;
    }
  }, [agentRun?.activities, agentRun?.messages]);
  const references = useMemo(() => referenceCitations(agentRun?.citations || []), [agentRun?.citations]);
  useLayoutEffect(() => {
    if (!hasAgentRun) return undefined;
    return store.markDomCommit(agentRunId, streamRenderRevision);
  }, [agentRunId, hasAgentRun, store, streamRenderRevision]);
  useEffect(() => {
    agentRun?.messages
      .filter((message) => message.phase === "active")
      .forEach((message) => streamedMessageIdsRef.current.add(message.messageId));
  }, [agentRun?.messages]);
  if (!agentRun) return null;
  const projectionFailed = Boolean(agentRun.projectionError) || sections === null;
  const userMessages = agentRun.messages.filter((message) => message.role === "user");
  const assistant = agentRun.messages.findLast((message) => message.role === "assistant");
  const partialAnswer = agentRun.status === "failed" && !!assistant?.text?.trim();
  const runningActivity = agentRun.activities.findLast((activity) => activity.status === "running");
  const assistantIsOutputting = Boolean(assistant?.text)
    && ["active", "final"].includes(assistant.phase)
    && assistant.sequence > Math.max(agentRun.activities.at(-1)?.sequence ?? -1, userMessages.at(-1)?.sequence ?? -1);
  const livePresentation = agentRun.connection === "reconnecting"
    ? { label: "Reconnecting" }
    : !projectionFailed && runningActivity ? runningActivityPresentation(runningActivity) : { label: "Thinking" };
  const LiveIcon = TOOL_ICONS[livePresentation.icon];
  const showLiveStatus = active
    && userMessages.length > 0
    && (!assistantIsOutputting || agentRun.connection === "reconnecting" || Boolean(runningActivity));
  const toggleDisclosure = (identity) => store.toggleActivityDisclosure(agentRunId, identity);

  async function copyMessage(message) {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopiedMessageId(message.messageId);
      window.setTimeout(() => setCopiedMessageId((current) => current === message.messageId ? "" : current), 1600);
    } catch {
      // Clipboard refusal must not disturb the conversation.
    }
  }

  function renderSection(section) {
    const message = section.message;
    const messageVisible = message?.text && (agentRun.status !== "failed" || message !== assistant || partialAnswer);
    const toolGroups = section.toolGroups;
    if (!messageVisible && !toolGroups.length) return null;
    const sealed = message && (message.phase !== "active" || !active);
    const smoothMarkdown = message && (!sealed || streamedMessageIdsRef.current.has(message.messageId));
    const answerMarkdown = !message
      ? null
      : smoothMarkdown
        ? <StreamingMarkdownContent text={message.text} finalized={sealed} />
        : <MarkdownContent text={message.text} />;
    return (
      <section className="workspaceProcessSection" data-turn-id={section.turnId} key={section.sectionId}>
        {messageVisible ? message.phase === "compaction" ? (
          <div className="workspaceCompactionMarker">{message.text}</div>
        ) : message.phase === "stage" ? (
          <div className="workspaceStageSummary"><MarkdownContent text={message.text} /></div>
        ) : sealed ? (
          <div className={message.phase === "final" ? "workspaceTerminalAnswer" : "workspaceStageSummary"} aria-live={message.phase === "final" ? "polite" : undefined}>
            {answerMarkdown}
            {message.phase === "final" && message.artifacts?.length ? <div className="workspaceArtifactInline" aria-label="生成的文件">{message.artifacts.map((artifact) => <span className="workspaceArtifactInlineRow" key={artifact.artifactRef}><span className="workspaceArtifactPlus" aria-hidden="true">+</span><a id={`artifact:${agentRun.id}:${artifact.artifactRef}`} href={artifact.downloadUrl} onClick={(event) => { event.preventDefault(); onShowArtifact?.(agentRun.id, artifact); }}>{artifact.filename}</a></span>)}</div> : null}
          </div>
        ) : <div className="workspaceAnswerText isStreaming">{answerMarkdown}</div> : null}
        {messageVisible && sealed && message.phase === "final" ? <div className={`workspaceAssistantMessageMeta ${copiedMessageId === message.messageId ? "isCopied" : ""}`}><time>{formatMessageTime(message.createdAtMs)}</time><button type="button" onClick={() => void copyMessage(message)} aria-label="复制回答" title="复制回答">{copiedMessageId === message.messageId ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button></div> : null}
        {toolGroups.length ? <div className="workspaceActivityGroups" aria-label="Tool activity">{toolGroups.map((group) => {
          const groupId = group.activityIds[0];
          return <ActivityGroup group={group} expanded={expandedActivities.has(groupId)} onToggle={() => toggleDisclosure(groupId)} expandedOperations={expandedActivities} onToggleOperation={toggleDisclosure} key={groupId} />;
        })}</div> : null}
      </section>
    );
  }

  return (
    <article className="workspaceAgentRun" data-agent-run-id={agentRun.id}>
      {userMessages.map((message) => (
        <div className={`workspaceUserMessageStack ${message.entryMotion === "conversation" ? "isConversationEntry" : ""}`} key={message.messageId}>
          {message.attachments?.length ? <div className="workspaceMessageAttachments" aria-label="本条消息附件">{message.attachments.map((attachment) => {
            const asset = assetByInputRef.get(attachment.inputRef);
            return <AttachmentCard className="workspaceMessageAttachment" attachment={asset ? { ...asset, displayName: attachment.displayName } : attachment} unavailable={!asset} onPreview={asset ? () => onShowAttachment?.(asset) : undefined} key={attachment.inputRef} />;
          })}</div> : null}
          {editingMessageId === message.messageId ? (
            <div className="workspaceUserMessage isEditing">
              <textarea value={editingPrompt} onChange={(event) => onEditingPromptChange?.(event.target.value)} aria-label="编辑消息" autoFocus />
              <div className="workspaceUserEditActions">
                <button type="button" onClick={onCancelEditingMessage} disabled={editingDisabled}>取消</button>
                <button className="isPrimary" type="button" onClick={onSubmitEditingMessage} disabled={editingDisabled || !editingPrompt.trim()}>发送</button>
              </div>
            </div>
          ) : (
            <>
              <div className="workspaceUserMessage"><span>{message.text}</span></div>
              <div className={`workspaceUserMessageMeta ${copiedMessageId === message.messageId ? "isCopied" : ""}`}>
                <time>{formatMessageTime(message.createdAtMs)}</time>
                <button type="button" onClick={() => void copyMessage(message)} aria-label="复制" title="复制">{copiedMessageId === message.messageId ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button>
                {editableMessageId === message.messageId ? <button type="button" onClick={() => onStartEditingMessage?.(message)} aria-label="编辑" title="编辑"><Pencil aria-hidden="true" /></button> : null}
              </div>
            </>
          )}
        </div>
      ))}
      <div className="workspaceAnswer">
        {projectionFailed ? (
          <div className="workspaceProjectionFailure" role="alert">
            <span>此轮内容暂时无法显示，其他会话功能仍可使用。</span>
            <button type="button" onClick={() => onRetryAgentRun?.(agentRun.id)}>重新读取</button>
          </div>
        ) : <>
          {sections.map(renderSection)}
          {showLiveStatus ? <LiveStatus Icon={LiveIcon} label={livePresentation.label} startedAtMs={agentRun.phaseStartedAtMs ?? agentRun.startedAtMs} /> : null}
          {references.length ? <section className="workspaceAnswerSection" aria-label="引用"><h3>引用</h3><div className="workspaceCitationList">{references.map((citation) => <button className="workspaceCitationChip" id={`citation:${agentRun.id}:${citation.citationId}`} key={citation.citationId} onClick={() => onShowCitation(agentRun.id, citation)}><FileText aria-hidden="true" /><span>{citation.displayName}</span><small>引用</small></button>)}</div></section> : null}
        </>}
      </div>
    </article>
  );
});
