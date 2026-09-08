import { t } from "../i18n";
import { useTranslation } from "../i18n";
import {
  Component,
  memo,
  useEffect,
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
            <span>{t("agentRunRow.thisRunIsTemporarilyUnavailableOtherConversationFeaturesAre")}</span>
            <button type="button" onClick={this.retry}>{t("agentRunRow.reload")}</button>
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
  const { t } = useTranslation();
  const { agentRunIds } = useAgentRunList(store) as AgentRunListSnapshot;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const isFollowingLatestRef = useRef(true);
  const followingScopeRef = useRef<{
    sessionId: string | null;
    loadingHistory: boolean;
  } | null>(null);
  const lastScrollTopRef = useRef(0);
  const touchYRef = useRef<number | null>(null);
  const draggingScrollbarRef = useRef(false);
  const smoothJumpRef = useRef(false);
  const reconcileFrameRef = useRef<number | null>(null);
  const historyAnchorRef = useRef<{ node: Element; offset: number; index: string | null } | null>(null);
  const loadingOlderRef = useRef(false);
  const virtualizer = useVirtualizer({
    count: agentRunIds.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 220,
    overscan: 6,
    getItemKey: (index) => agentRunIds[index],
    // End following is owned here: layout corrections must not be confused
    // with user navigation, and must not compete with a scroll animation.
    anchorTo: isFollowingLatest ? "start" : "end",
    followOnAppend: false,
    scrollEndThreshold: END_TOLERANCE_PX,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if (isFollowingLatestRef.current) return false;
    if (item.index === agentRunIds.length - 1) return false;
    return item.start < (instance.scrollOffset ?? 0)
      && instance.scrollDirection !== "backward";
  };
  useLayoutEffect(() => {
    const previousScope = followingScopeRef.current;
    if (previousScope?.sessionId === sessionId && previousScope.loadingHistory === loadingHistory) return;
    followingScopeRef.current = { sessionId, loadingHistory };
    historyAnchorRef.current = null;
    smoothJumpRef.current = false;
    isFollowingLatestRef.current = true;
    setIsFollowingLatest(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "instant" });
    lastScrollTopRef.current = scrollRef.current?.scrollTop || 0;
  }, [sessionId, loadingHistory]);

  const totalSize = virtualizer.getTotalSize();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Measured content growth must reconcile and preserve the end anchor.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const anchor = historyAnchorRef.current;
    if (!isFollowingLatestRef.current && anchor?.node.isConnected) {
      // Prepend estimates can be replaced by measured heights after the
      // virtualizer applies its initial offset. Preserve the visible row.
      const delta = anchor.node.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset;
      if (Math.abs(delta) > 0.5) element.scrollTop += delta;
      lastScrollTopRef.current = element.scrollTop;
      return;
    }
    const distanceFromEnd = element.scrollHeight - element.clientHeight - element.scrollTop;
    if (distanceFromEnd <= END_TOLERANCE_PX) return;
    if (!isFollowingLatestRef.current) return;
    smoothJumpRef.current = false;
    element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
    lastScrollTopRef.current = element.scrollTop;
  }, [totalSize]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    // A viewport resize need not change the virtual range or cause a render.
    const observer = new ResizeObserver(() => {
      if (!isFollowingLatestRef.current) return;
      smoothJumpRef.current = false;
      element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
      lastScrollTopRef.current = element.scrollTop;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const releasePointer = () => { draggingScrollbarRef.current = false; };
    window.addEventListener("pointerup", releasePointer);
    window.addEventListener("pointercancel", releasePointer);
    return () => {
      if (reconcileFrameRef.current !== null) cancelAnimationFrame(reconcileFrameRef.current);
      window.removeEventListener("pointerup", releasePointer);
      window.removeEventListener("pointercancel", releasePointer);
    };
  }, []);

  function stopFollowing() {
    const element = scrollRef.current;
    if (!element || (element.scrollTop <= 0 && !smoothJumpRef.current)) return;
    isFollowingLatestRef.current = false;
    smoothJumpRef.current = false;
    setIsFollowingLatest(false);
    // Stop an in-flight native smooth jump without scheduling another target.
    element.scrollTo({ top: element.scrollTop, behavior: "instant" });
  }

  function isListScroll(target: EventTarget | null, delta: number) {
    const list = scrollRef.current;
    let node = target instanceof Element ? target : null;
    while (node && node !== list) {
      const overflow = getComputedStyle(node).overflowY;
      if (/(auto|scroll)/.test(overflow) && node.scrollHeight > node.clientHeight
        && (delta < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight)) return false;
      node = node.parentElement;
    }
    return node === list;
  }

  async function handleScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const nextScrollTop = element.scrollTop;
    const historyAnchor = historyAnchorRef.current;
    if (historyAnchor?.node.isConnected && historyAnchor.node.getAttribute("data-index") === historyAnchor.index) {
      // The user can finish a keyboard/touch scroll while the older page is
      // still in flight. Anchor where reading actually settles, not at admission.
      historyAnchor.offset = historyAnchor.node.getBoundingClientRect().top - element.getBoundingClientRect().top;
    }
    const movedAwayFromLatest = draggingScrollbarRef.current
      && nextScrollTop < lastScrollTopRef.current - END_TOLERANCE_PX;
    const atEnd = element.scrollHeight - element.clientHeight - nextScrollTop <= END_TOLERANCE_PX;
    const nextIsFollowingLatest = (atEnd && nextScrollTop > lastScrollTopRef.current)
      || (isFollowingLatestRef.current && !movedAwayFromLatest);
    lastScrollTopRef.current = nextScrollTop;
    if (nextIsFollowingLatest !== isFollowingLatestRef.current) {
      isFollowingLatestRef.current = nextIsFollowingLatest;
      setIsFollowingLatest(nextIsFollowingLatest);
    }
    if (atEnd) smoothJumpRef.current = false;
    if (nextIsFollowingLatest && !atEnd && !smoothJumpRef.current && reconcileFrameRef.current === null) {
      reconcileFrameRef.current = requestAnimationFrame(() => {
        reconcileFrameRef.current = null;
        if (!isFollowingLatestRef.current || smoothJumpRef.current) return;
        element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
        lastScrollTopRef.current = element.scrollTop;
      });
    }
    if (
      element.scrollTop > LOAD_OLDER_PX
      || !hasMoreHistory
      || loadingOlderHistory
      || loadingOlderRef.current
    ) return;
    loadingOlderRef.current = true;
    const listTop = element.getBoundingClientRect().top;
    const anchorNode = [...element.querySelectorAll(".workspaceVirtualAgentRun")]
      .find((node) => node.getBoundingClientRect().bottom > listTop);
    if (!isFollowingLatestRef.current && anchorNode) {
      historyAnchorRef.current = { node: anchorNode, offset: anchorNode.getBoundingClientRect().top - listTop, index: anchorNode.getAttribute("data-index") };
    }
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
    historyAnchorRef.current = null;
    setIsFollowingLatest(true);
    smoothJumpRef.current = !prefersReducedMotion && !!element && distance <= element.clientHeight;
    element?.scrollTo({
      top: element.scrollHeight - element.clientHeight,
      behavior: smoothJumpRef.current ? "smooth" : "auto",
    });
  }

  const virtualItems = virtualizer.getVirtualItems();
  return (
    <div className="workspaceAgentRunList">
      <div
        className="workspaceMessages" ref={scrollRef} onScroll={handleScroll}
        data-testid="virtual-agent-run-list" tabIndex={0} role="region" aria-label={t("virtualAgentRunList.conversationMessages")}
        onWheel={(event) => {
          if (event.deltaY !== 0 && isListScroll(event.target, event.deltaY)) {
            historyAnchorRef.current = null;
            if (event.deltaY < 0) stopFollowing();
          }
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
          if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) historyAnchorRef.current = null;
          if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) stopFollowing();
        }}
        onTouchStart={(event) => { touchYRef.current = event.touches[0]?.clientY ?? null; }}
        onTouchMove={(event) => {
          const y = event.touches[0]?.clientY;
          if (y !== undefined && touchYRef.current !== null && y !== touchYRef.current
            && isListScroll(event.target, touchYRef.current - y)) historyAnchorRef.current = null;
          if (y !== undefined && touchYRef.current !== null && y > touchYRef.current
            && isListScroll(event.target, touchYRef.current - y)) stopFollowing();
          touchYRef.current = y ?? null;
        }}
        onTouchEnd={() => { touchYRef.current = null; }}
        onTouchCancel={() => { touchYRef.current = null; }}
        onPointerDown={(event) => {
          const element = event.currentTarget;
          historyAnchorRef.current = null;
          const rect = element.getBoundingClientRect();
          draggingScrollbarRef.current = event.pointerType === "mouse" && event.target === element
            && (event.clientX >= rect.left + element.clientLeft + element.clientWidth || event.clientX < rect.left + element.clientLeft);
          if (draggingScrollbarRef.current) stopFollowing();
        }}
      >
        {loadingHistory ? <div className="workspaceEmptyState" role="status" aria-live="polite">{t("virtualAgentRunList.loadingConversation")}</div> : null}
        {!loadingHistory && !agentRunIds.length ? (
          emptyState ?? (
            <div className="workspaceEmptyState workspaceEmptyBrand" aria-label={t("virtualAgentRunList.newChat")}>
              <h2>Centaeris</h2>
              <p>{t("virtualAgentRunList.startWithATask")}</p>
            </div>
          )
        ) : null}
        {agentRunIds.length ? (
          <div className="workspaceVirtualMessageCanvas" style={{ height: `${totalSize}px` }}>
            {loadingOlderHistory ? <div className="workspaceHistoryLoading" role="status" aria-live="polite">{t("virtualAgentRunList.loadingEarlierMessages")}</div> : null}
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
          aria-label={t("virtualAgentRunList.jumpToLatest")}
          title={t("virtualAgentRunList.jumpToLatest")}
        >
          <ChevronDown aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
});
