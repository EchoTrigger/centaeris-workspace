import { useTranscriptCitations } from "./useTranscriptCitations";
import type { CitationSummary } from "./citationSnapshot";
import { createMessageScroll } from "./messageScroll";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranscriptTurnMetadata } from "./useTranscriptTurnMetadata";
import { WorkProgress } from "./WorkProgress";
import { groupTranscriptTurns, shouldLoadEarlier } from "./transcriptTurns";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "../i18n";
import { TranscriptBlockRow, TranscriptLiveTail, TranscriptToolGroupCard } from "./TranscriptBlockContent";
import type { TranscriptToolOperationRegistry } from "./transcriptToolOperations";
import type { TranscriptViewStore } from "./transcriptViewStore";


type Props = Readonly<{
  store: TranscriptViewStore;
  toolOperations?: TranscriptToolOperationRegistry;
  sessionId: string | null;
  loadingHistory: boolean;
  loadingOlderHistory: boolean;
  onLoadOlderHistory(): Promise<void>;
  emptyState?: ReactNode;
  pendingUserMessage?: Readonly<{ text: string; startedAtMs: number; baselineUserBlocks: number }> | null;
  onShowCitation?(citation: CitationSummary, origin: { elementId: string }): void;
  onShowArtifact?(artifact: import("./useTranscriptTurnMetadata").PublishedArtifact): void;
  running?: boolean;
  startedAtMs?: number;
  completedAtMs?: number;
}>;

function useTranscriptList(store: TranscriptViewStore) {
  return useSyncExternalStore(store.subscribeList, store.getListSnapshot, store.getListSnapshot);
}

function useTranscriptLive(store: TranscriptViewStore) {
  return useSyncExternalStore(store.subscribeLive, store.getLiveSnapshot, store.getLiveSnapshot);
}

type TranscriptListEntry =
  | Readonly<{ kind: "block"; blockId: string }>
  | Readonly<{ kind: "tool"; blockIds: string[] }>;

// Consecutive tool blocks share one card, mirroring how the desktop host
// groups consecutive tool tasks.
function groupTranscriptBlocks(
  store: TranscriptViewStore,
  blockIds: readonly string[],
): TranscriptListEntry[] {
  const entries: TranscriptListEntry[] = [];
  let pendingTools: string[] = [];
  const flushTools = () => {
    if (pendingTools.length > 0) {
      entries.push({ kind: "tool", blockIds: pendingTools });
      pendingTools = [];
    }
  };
  for (const blockId of blockIds) {
    const block = store.getBlockSnapshot(blockId);
    const body = block?.body as { kind?: unknown } | undefined;
    if (body && body.kind === "tool") {
      pendingTools.push(blockId);
      continue;
    }
    flushTools();
    entries.push({ kind: "block", blockId });
  }
  flushTools();
  return entries;
}

export const TranscriptBlockList = memo(function TranscriptBlockList({
  store,
  toolOperations,
  sessionId,
  loadingHistory,
  loadingOlderHistory,
  onLoadOlderHistory,
  emptyState,
  pendingUserMessage,
  onShowArtifact,
  onShowCitation,
  running = false,
  startedAtMs,
  completedAtMs,
}: Props) {
  const { t } = useTranslation();
  const { blockIds, hasOlder } = useTranscriptList(store);
  const live = useTranscriptLive(store);
  const citations = useTranscriptCitations(store, sessionId);
  const turns = useMemo(() => groupTranscriptTurns(blockIds, store.getBlockSnapshot), [store, blockIds]);
  const turnAnchors = turns.map((turn) => store.getBlockSnapshot(turn.userBlockId ?? turn.processIds[0] ?? turn.answerIds[0])?.orderKey.sourceSequence ?? "");
  const workTimes = useTranscriptTurnMetadata(sessionId, turnAnchors.filter(Boolean).join(","), running);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ReturnType<typeof createMessageScroll> | null>(null);
  const lastSentRef = useRef<number | null>(null);
  const pendingAnchorRef = useRef<{ userId: string | null } | null>(null);
  const userScrollInputRef = useRef(0);
  const scrollbarDragRef = useRef(false);
  const touchYRef = useRef<number | null>(null);
  const upwardIntentRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const anchorRef = useRef<{ blockId: string; offset: number } | null>(null);
  const previousCountRef = useRef(blockIds.length);
  const [followingLatest, setFollowingLatest] = useState(true);
  const resetIdentity = sessionId ?? "";
  const userTurns = turns.filter((turn) => turn.userBlockId);
  const lastUserId = userTurns[userTurns.length - 1]?.userBlockId ?? null;
  const pendingVisible = pendingUserMessage && userTurns.length <= pendingUserMessage.baselineUserBlocks;

  const getController = useCallback(() => {
    controllerRef.current ??= createMessageScroll({
      measure: () => {
        const element = scrollRef.current;
        const content = contentRef.current;
        if (!element || !content) return null;
        const top = element.getBoundingClientRect().top;
        const anchors = content.querySelectorAll<HTMLElement>("[data-send-anchor]");
        const anchor = anchors[anchors.length - 1];
        return { height: element.clientHeight, scrollTop: element.scrollTop,
          contentEnd: content.getBoundingClientRect().bottom - top + element.scrollTop + parseFloat(getComputedStyle(element).paddingBottom || "0"),
          anchorTop: anchor ? anchor.getBoundingClientRect().top - top + element.scrollTop : 0 };
      },
      setPadding: (value) => { if (spacerRef.current) spacerRef.current.style.height = `${value}px`; },
      scrollTo: (top) => { if (scrollRef.current) scrollRef.current.scrollTop = top; },
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (id) => cancelAnimationFrame(id),
      reducedMotion: () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
      onFollowingChange: setFollowingLatest,
    });
    return controllerRef.current;
  }, []);
  const pendingStartedAt = pendingUserMessage?.startedAtMs;

  // biome-ignore lint/correctness/useExhaustiveDependencies: only identity changes reset scrolling; pending admission must preserve the anchor.
  useLayoutEffect(() => {
    void resetIdentity;
    anchorRef.current = null;
    upwardIntentRef.current = false;
    if (pendingStartedAt === undefined) {
      getController().reset();
      getController().update();
    }
    // A newly created session can acquire its durable ID during this send.
    // Preserve its ongoing animation until the pending message is admitted.
  }, [resetIdentity, getController]);

  useLayoutEffect(() => {
    if (pendingStartedAt !== undefined && lastSentRef.current !== pendingStartedAt) {
      lastSentRef.current = pendingStartedAt;
      pendingAnchorRef.current = { userId: lastUserId };
      getController().anchor();
    } else if (pendingStartedAt === undefined && pendingAnchorRef.current) {
      if (pendingAnchorRef.current.userId === lastUserId) getController().jump();
      else getController().update();
      pendingAnchorRef.current = null;
    }
  }, [pendingStartedAt, lastUserId, getController]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const anchor = anchorRef.current;
    if (!element || previousCountRef.current === blockIds.length) return;
    previousCountRef.current = blockIds.length;
    if (anchor !== null) {
      const node = element.querySelector(`[data-block-id="${CSS.escape(anchor.blockId)}"]`);
      if (node !== null) {
        element.scrollTop += node.getBoundingClientRect().top
          - element.getBoundingClientRect().top - anchor.offset;
      }
      anchorRef.current = null;
    } else getController().update();
  }, [blockIds, getController]);

  useEffect(() => {
    const content = contentRef.current;
    const element = scrollRef.current;
    if (!content || !element) return undefined;
    const observer = new ResizeObserver(() => getController().update());
    observer.observe(content);
    observer.observe(element);
    return () => { observer.disconnect(); controllerRef.current?.dispose(); };
  }, [getController]);

  async function requestOlder() {
    const element = scrollRef.current;
    if (!element || !hasOlder || loadingOlderHistory || loadingOlderRef.current) return;
    const listTop = element.getBoundingClientRect().top;
    const anchor = [...element.querySelectorAll<HTMLElement>("[data-block-id]")]
      .find((node) => node.getBoundingClientRect().bottom > listTop);
    if (anchor) {
      anchorRef.current = {
        blockId: anchor.dataset.blockId || "",
        offset: anchor.getBoundingClientRect().top - listTop,
      };
    }
    loadingOlderRef.current = true;
    try {
      await onLoadOlderHistory();
    } finally {
      loadingOlderRef.current = false;
    }
  }

  function recordUpwardIntent() {
    upwardIntentRef.current = true;
    getController().pause();
    const element = scrollRef.current;
    if (element && shouldLoadEarlier(element.scrollTop, hasOlder, loadingOlderHistory)) {
      upwardIntentRef.current = false;
      void requestOlder();
    }
  }

  function handleScroll() {
    const element = scrollRef.current;
    if (!element) return;
    // Ignore scroll events with no recent user input (browser scroll anchoring,
    // expand/collapse layout shifts) so they never detach following by themselves.
    if (!scrollbarDragRef.current && performance.now() - userScrollInputRef.current > 150) return;
    getController().userScroll();
    if (shouldLoadEarlier(element.scrollTop, hasOlder, loadingOlderHistory) && upwardIntentRef.current) {
      upwardIntentRef.current = false;
      void requestOlder();
    }
  }

  function scrollToLatest() {
    getController().jump();
  }

  return (
    <div className="workspaceAgentRunList">
      <div
        className="workspaceMessages"
        ref={scrollRef}
        onScroll={handleScroll}
        onPointerDown={(event) => {
          if (!(event.target as HTMLElement).closest("button, a, [role=button]")) {
            scrollbarDragRef.current = true;
            userScrollInputRef.current = performance.now();
          }
        }}
        onPointerUp={() => { scrollbarDragRef.current = false; }}
        onPointerCancel={() => { scrollbarDragRef.current = false; }}
        onWheel={(event) => { userScrollInputRef.current = performance.now(); if (event.deltaY < 0) recordUpwardIntent(); }}
        onTouchStart={(event) => { touchYRef.current = event.touches[0]?.clientY ?? null; }}
        onTouchMove={(event) => {
          userScrollInputRef.current = performance.now();
          const nextY = event.touches[0]?.clientY ?? null;
          if (nextY !== null && touchYRef.current !== null && nextY > touchYRef.current) {
            recordUpwardIntent();
          }
          touchYRef.current = nextY;
        }}
        onTouchEnd={() => { touchYRef.current = null; }}
        onKeyDown={(event) => {
          userScrollInputRef.current = performance.now();
          if (["ArrowUp", "PageUp", "Home"].includes(event.key)
            || (event.key === " " && event.shiftKey)) recordUpwardIntent();
        }}
        tabIndex={0}
        role="region"
        aria-label={t("virtualAgentRunList.conversationMessages")}
      >
        {loadingHistory ? <div className="workspaceEmptyState" role="status">{t("virtualAgentRunList.loadingConversation")}</div> : null}
        {!loadingHistory && blockIds.length === 0 && live === null && !pendingVisible ? (emptyState || null) : null}
        {citations.error ? <div role="status" className="workspaceToolOutputStatus">
          {t("appRoute.citationRefreshFailed")}
          <button type="button" onClick={citations.retry}>{t("codePreview.retry")}</button>
        </div> : null}
        <div className="workspaceTranscriptBlocks" ref={contentRef}>
          {turns.map((turn, index) => {
            const isLast = index === turns.length - 1 && !pendingVisible;
            const turnLive = isLast ? live : null;
            const time = workTimes.get(turnAnchors[index]);
            return <div className="workspaceTranscriptTurn" data-send-anchor={turn.userBlockId ? "" : undefined} key={turn.id}>
              {turn.userBlockId ? <TranscriptBlockRow store={store} blockId={turn.userBlockId} /> : null}
              <WorkProgress running={isLast && running} finalStarted={turn.answerIds.length > 0}
                startedAtMs={time?.startedAtMs ?? (isLast ? startedAtMs : undefined)} completedAtMs={time?.completedAtMs ?? (isLast ? completedAtMs : undefined)}>
                {groupTranscriptBlocks(store, turn.processIds).map((entry) => entry.kind === "tool"
                  ? <TranscriptToolGroupCard store={store} blockIds={entry.blockIds} toolOperations={toolOperations} citations={citations.citations} onShowCitation={onShowCitation} key={`tool:${entry.blockIds[0]}`} />
                  : <TranscriptBlockRow store={store} blockId={entry.blockId} key={entry.blockId} />)}
                {turnLive ? <TranscriptLiveTail live={turnLive} /> : null}
              </WorkProgress>
              {turn.answerIds.map((blockId) => <TranscriptBlockRow store={store} blockId={blockId} key={blockId} />)}
              {time?.artifacts.length ? <div className="workspaceArtifactInline" aria-label={t("agentRunRow.generatedFiles")}>
                {time.artifacts.map((artifact) => <span className="workspaceArtifactInlineRow" key={artifact.artifactRef}>
                  <span className="workspaceArtifactPlus" aria-hidden="true">+</span>
                  <a href={artifact.downloadUrl} onClick={onShowArtifact ? (event) => { event.preventDefault(); onShowArtifact(artifact); } : undefined}>{artifact.filename}</a>
                </span>)}
              </div> : null}
            </div>;
          })}
          {pendingVisible ? (
            <div className="workspaceTranscriptBlock workspaceTranscriptUser" data-block-id="pending:user" data-send-anchor="">
              <div className="workspaceUserMessage">{pendingUserMessage.text}</div>
            </div>
          ) : null}
          {pendingVisible ? <WorkProgress running finalStarted={false} startedAtMs={pendingUserMessage.startedAtMs} /> : null}
        </div>
        <div ref={spacerRef} aria-hidden="true" style={{ height: 0, flexShrink: 0 }} />
      </div>
      {!followingLatest && (blockIds.length > 0 || live !== null) ? (
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
