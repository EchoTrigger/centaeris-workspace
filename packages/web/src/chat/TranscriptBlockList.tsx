import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "../i18n";
import { TranscriptBlockRow, TranscriptLiveTail, TranscriptToolGroupCard } from "./TranscriptBlockContent";
import type { TranscriptToolOperationRegistry } from "./transcriptToolOperations";
import type { TranscriptViewStore } from "./transcriptViewStore";

const END_TOLERANCE_PX = 2;
const LOAD_OLDER_PX = 180;

type Props = Readonly<{
  store: TranscriptViewStore;
  toolOperations?: TranscriptToolOperationRegistry;
  sessionId: string | null;
  loadingHistory: boolean;
  loadingOlderHistory: boolean;
  onLoadOlderHistory(): Promise<void>;
  emptyState?: ReactNode;
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
}: Props) {
  const { t } = useTranslation();
  const { blockIds, hasOlder } = useTranscriptList(store);
  const live = useTranscriptLive(store);
  const entries = useMemo(() => groupTranscriptBlocks(store, blockIds), [store, blockIds]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const touchYRef = useRef<number | null>(null);
  const upwardIntentRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const anchorRef = useRef<{ blockId: string; offset: number } | null>(null);
  const previousCountRef = useRef(blockIds.length);
  const followingLatestRef = useRef(true);
  const [followingLatest, setFollowingLatest] = useState(true);
  const resetIdentity = `${sessionId ?? ""}:${loadingHistory}`;

  useLayoutEffect(() => {
    void resetIdentity;
    anchorRef.current = null;
    upwardIntentRef.current = false;
    followingLatestRef.current = true;
    setFollowingLatest(true);
    const element = scrollRef.current;
    element?.scrollTo({ top: element.scrollHeight, behavior: "instant" });
  }, [resetIdentity]);

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
    } else if (followingLatestRef.current) {
      element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
    }
  }, [blockIds]);

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
    followingLatestRef.current = false;
    setFollowingLatest(false);
  }

  function handleScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const atEnd = element.scrollHeight - element.clientHeight - element.scrollTop <= END_TOLERANCE_PX;
    if (atEnd !== followingLatestRef.current) {
      followingLatestRef.current = atEnd;
      setFollowingLatest(atEnd);
    }
    if (element.scrollTop <= LOAD_OLDER_PX && upwardIntentRef.current) {
      upwardIntentRef.current = false;
      void requestOlder();
    }
  }

  function scrollToLatest() {
    followingLatestRef.current = true;
    setFollowingLatest(true);
    const element = scrollRef.current;
    element?.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }

  return (
    <div className="workspaceAgentRunList">
      <div
        className="workspaceMessages"
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={(event) => { if (event.deltaY < 0) recordUpwardIntent(); }}
        onTouchStart={(event) => { touchYRef.current = event.touches[0]?.clientY ?? null; }}
        onTouchMove={(event) => {
          const nextY = event.touches[0]?.clientY ?? null;
          if (nextY !== null && touchYRef.current !== null && nextY > touchYRef.current) {
            recordUpwardIntent();
          }
          touchYRef.current = nextY;
        }}
        onTouchEnd={() => { touchYRef.current = null; }}
        onKeyDown={(event) => {
          if (["ArrowUp", "PageUp", "Home"].includes(event.key)
            || (event.key === " " && event.shiftKey)) recordUpwardIntent();
        }}
        tabIndex={0}
        role="region"
        aria-label={t("virtualAgentRunList.conversationMessages")}
      >
        {loadingHistory ? <div className="workspaceEmptyState" role="status">{t("virtualAgentRunList.loadingConversation")}</div> : null}
        {!loadingHistory && blockIds.length === 0 && live === null ? (emptyState || null) : null}
        {!loadingHistory && hasOlder ? (
          <button
            className="workspaceTranscriptLoadOlder"
            type="button"
            disabled={loadingOlderHistory}
            onClick={() => { upwardIntentRef.current = false; void requestOlder(); }}
          >
            {loadingOlderHistory
              ? t("virtualAgentRunList.loadingEarlierMessages")
              : t("virtualAgentRunList.loadEarlierMessages")}
          </button>
        ) : null}
        <div className="workspaceTranscriptBlocks">
          {entries.map((entry) => entry.kind === "tool"
            ? <TranscriptToolGroupCard store={store} blockIds={entry.blockIds} toolOperations={toolOperations} key={`tool:${entry.blockIds[0]}`} />
            : <TranscriptBlockRow store={store} blockId={entry.blockId} key={entry.blockId} />)}
          {live === null ? null : <TranscriptLiveTail live={live} />}
        </div>
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
