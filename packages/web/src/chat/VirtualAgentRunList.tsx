import {
  Component,
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown } from "lucide-react";
import { useAgentRunList } from "./chatStoreHooks";
import { AgentRunRow } from "./AgentRunRow";

const END_TOLERANCE_PX = 2;
const LOAD_OLDER_PX = 180;

type AgentRunListSnapshot = {
  agentRunIds: string[];
};

type ChatViewStore = {
  subscribeList: (listener: () => void) => () => void;
  getListSnapshot: () => AgentRunListSnapshot;
};

export type AgentRunCitation = {
  citationId: string;
  displayName: string;
  sourceUrl: string;
};

export type AgentRunArtifact = {
  artifactRef: string;
  downloadUrl: string;
  filename: string;
};

export type AgentRunAsset = {
  id: string;
  displayName: string;
  contentType?: string;
};

export type EditableAgentRunMessage = {
  messageId: string;
  text: string;
  attachments?: Array<{ inputRef: string }>;
};

type VirtualAgentRunListProps = {
  store: ChatViewStore;
  sessionId: string | null;
  loadingHistory: boolean;
  hasMoreHistory: boolean;
  loadingOlderHistory: boolean;
  onLoadOlderHistory: () => Promise<void>;
  emptyState?: ReactNode;
  onShowCitation?: (agentRunId: string, citation: AgentRunCitation) => void;
  onShowArtifact?: (agentRunId: string, artifact: AgentRunArtifact) => void;
  assets?: AgentRunAsset[];
  onShowAttachment?: (asset: AgentRunAsset) => void;
  editableMessageId?: string;
  editingMessageId?: string;
  editingPrompt?: string;
  editingDisabled?: boolean;
  onStartEditingMessage?: (message: EditableAgentRunMessage) => void;
  onEditingPromptChange?: (text: string) => void;
  onCancelEditingMessage?: () => void;
  onSubmitEditingMessage?: () => void;
  onRetryAgentRun?: (agentRunId: string) => void | Promise<void>;
};

type AgentRunErrorBoundaryProps = {
  agentRunId: string;
  onRetry?: VirtualAgentRunListProps["onRetryAgentRun"];
  children: ReactNode;
};

type AgentRunErrorBoundaryState = {
  failed: boolean;
};

type AgentRunRowProps = Pick<
  VirtualAgentRunListProps,
  | "store"
  | "onShowCitation"
  | "onShowArtifact"
  | "assets"
  | "onShowAttachment"
  | "editableMessageId"
  | "editingMessageId"
  | "editingPrompt"
  | "editingDisabled"
  | "onStartEditingMessage"
  | "onEditingPromptChange"
  | "onCancelEditingMessage"
  | "onSubmitEditingMessage"
  | "onRetryAgentRun"
> & {
  agentRunId: string;
};

const TypedAgentRunRow = AgentRunRow as ComponentType<AgentRunRowProps>;

class AgentRunErrorBoundary extends Component<
  AgentRunErrorBoundaryProps,
  AgentRunErrorBoundaryState
> {
  state: AgentRunErrorBoundaryState = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    console.error("AgentRun render projection failed", { agentRunId: this.props.agentRunId });
  }

  retry = async () => {
    await this.props.onRetry?.(this.props.agentRunId);
    this.setState({ failed: false });
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <article className="workspaceAgentRun" data-agent-run-id={this.props.agentRunId}>
        <div className="workspaceAnswer">
          <div className="workspaceProjectionFailure" role="alert">
            <span>此轮内容暂时无法显示，其他会话功能仍可使用。</span>
            <button type="button" onClick={this.retry}>重新读取</button>
          </div>
        </div>
      </article>
    );
  }
}

export const VirtualAgentRunList = memo(function VirtualAgentRunList({
  store,
  sessionId,
  loadingHistory,
  hasMoreHistory,
  loadingOlderHistory,
  onLoadOlderHistory,
  emptyState,
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
}: VirtualAgentRunListProps) {
  const { agentRunIds } = useAgentRunList(store) as AgentRunListSnapshot;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const isFollowingLatestRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const virtualizer = useVirtualizer({
    count: agentRunIds.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 220,
    overscan: 6,
    getItemKey: (index) => agentRunIds[index],
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: END_TOLERANCE_PX,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if (isFollowingLatestRef.current) return true;
    if (item.index === agentRunIds.length - 1) return false;
    return item.start < (instance.scrollOffset ?? 0)
      && instance.scrollDirection !== "backward";
  };
  useLayoutEffect(() => {
    isFollowingLatestRef.current = true;
    setIsFollowingLatest(true);
    virtualizer.scrollToEnd();
    lastScrollTopRef.current = scrollRef.current?.scrollTop || 0;
  }, [sessionId, virtualizer]);

  const totalSize = virtualizer.getTotalSize();
  useLayoutEffect(() => {
    if (!isFollowingLatestRef.current) return;
    const element = scrollRef.current;
    if (!element) return;
    const distanceFromEnd = element.scrollHeight - element.clientHeight - element.scrollTop;
    if (distanceFromEnd <= END_TOLERANCE_PX) return;
    virtualizer.scrollToEnd();
    lastScrollTopRef.current = element.scrollTop;
  }, [totalSize, virtualizer]);

  async function handleScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const nextScrollTop = element.scrollTop;
    const movedAwayFromLatest = virtualizer.scrollDirection === "backward"
      || nextScrollTop < lastScrollTopRef.current - END_TOLERANCE_PX;
    const nextIsFollowingLatest = virtualizer.isAtEnd(END_TOLERANCE_PX)
      || (isFollowingLatestRef.current && !movedAwayFromLatest);
    lastScrollTopRef.current = nextScrollTop;
    if (nextIsFollowingLatest !== isFollowingLatestRef.current) {
      isFollowingLatestRef.current = nextIsFollowingLatest;
      setIsFollowingLatest(nextIsFollowingLatest);
    }
    if (
      element.scrollTop > LOAD_OLDER_PX
      || !hasMoreHistory
      || loadingOlderHistory
      || loadingOlderRef.current
    ) return;
    loadingOlderRef.current = true;
    try {
      await onLoadOlderHistory();
    } finally {
      loadingOlderRef.current = false;
    }
  }

  function scrollToLatest() {
    const element = scrollRef.current;
    const distance = element
      ? element.scrollHeight - element.clientHeight - element.scrollTop
      : Infinity;
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    isFollowingLatestRef.current = true;
    setIsFollowingLatest(true);
    virtualizer.scrollToEnd({
      behavior: !prefersReducedMotion && element && distance <= element.clientHeight ? "smooth" : "auto",
    });
  }

  const virtualItems = virtualizer.getVirtualItems();
  return (
    <div className="workspaceAgentRunList">
      <div className="workspaceMessages" ref={scrollRef} onScroll={handleScroll} data-testid="virtual-agent-run-list">
        {loadingHistory ? <div className="workspaceEmptyState" role="status" aria-live="polite">正在读取会话…</div> : null}
        {!loadingHistory && !agentRunIds.length ? (
          emptyState ?? (
            <div className="workspaceEmptyState workspaceEmptyBrand" aria-label="新会话">
              <h2>Centaeris</h2>
              <p>从一个任务开始</p>
            </div>
          )
        ) : null}
        {agentRunIds.length ? (
          <div className="workspaceVirtualMessageCanvas" style={{ height: `${totalSize}px` }}>
            {loadingOlderHistory ? <div className="workspaceHistoryLoading" role="status" aria-live="polite">正在读取更早内容…</div> : null}
            {virtualItems.map((item) => (
              <div
                className="workspaceVirtualAgentRun"
                data-index={item.index}
                key={item.key}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <div className="workspaceVirtualAgentRunInner">
                  <AgentRunErrorBoundary agentRunId={agentRunIds[item.index]} onRetry={onRetryAgentRun}>
                    <TypedAgentRunRow
                      store={store}
                      agentRunId={agentRunIds[item.index]}
                      onShowCitation={onShowCitation}
                      onShowArtifact={onShowArtifact}
                      assets={assets}
                      onShowAttachment={onShowAttachment}
                      editableMessageId={editableMessageId}
                      editingMessageId={editingMessageId}
                      editingPrompt={editingPrompt}
                      editingDisabled={editingDisabled}
                      onStartEditingMessage={onStartEditingMessage}
                      onEditingPromptChange={onEditingPromptChange}
                      onCancelEditingMessage={onCancelEditingMessage}
                      onSubmitEditingMessage={onSubmitEditingMessage}
                      onRetryAgentRun={onRetryAgentRun}
                    />
                  </AgentRunErrorBoundary>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {!isFollowingLatest && agentRunIds.length ? (
        <button
          type="button"
          className="workspaceJumpToLatest"
          onClick={scrollToLatest}
          aria-label="回到最新"
          title="回到最新"
        >
          <ChevronDown aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
});
