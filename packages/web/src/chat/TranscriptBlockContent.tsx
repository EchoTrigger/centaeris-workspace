import {
  memo,
  useCallback,
  useState,
  useSyncExternalStore,
  type ComponentType,
} from "react";
import { SquareTerminal } from "lucide-react";
import { useTranslation } from "../i18n.ts";
import { MarkdownContent, StreamingMarkdownContent } from "./MarkdownContent";
import {
  loadTranscriptContentRange,
  TRANSCRIPT_CONTENT_RANGE_BYTES,
} from "./transcriptContentRanges.ts";
import type {
  TranscriptBlock,
  TranscriptLiveOverlay,
  TranscriptViewStore,
} from "./transcriptViewStore";
import type { TranscriptContentRef } from "./transcriptContract.ts";

const LiveMarkdownContent = StreamingMarkdownContent as ComponentType<{
  text: string;
  finalized?: boolean;
}>;

function useTranscriptBlock(store: TranscriptViewStore, blockId: string) {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeBlock(blockId, listener),
    [blockId, store],
  );
  const snapshot = useCallback(() => store.getBlockSnapshot(blockId), [blockId, store]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function contentText(content: unknown) {
  if (typeof content !== "object" || content === null || !("inlineContent" in content)) return null;
  return typeof content.inlineContent === "string" ? content.inlineContent : null;
}

function contentReference(value: unknown): TranscriptContentRef | null {
  if (typeof value !== "object" || value === null) return null;
  const reference = value as Record<string, unknown>;
  if (typeof reference.refId !== "string"
    || typeof reference.revision !== "string"
    || typeof reference.byteLength !== "string") return null;
  return reference as TranscriptContentRef;
}

function TranscriptToolOutput({ store, reference }: Readonly<{
  store: TranscriptViewStore;
  reference: TranscriptContentRef;
}>) {
  const { t } = useTranslation();
  const identity = useSyncExternalStore(
    store.subscribeList,
    store.getListSnapshot,
    store.getListSnapshot,
  );
  const [content, setContent] = useState("");
  const [nextOffset, setNextOffset] = useState("0");
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function loadMore() {
    if (!identity.sessionId || !identity.projectionGeneration || loading || !hasMore) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    try {
      const page = await loadTranscriptContentRange({
        sessionId: identity.sessionId,
        projectionGeneration: identity.projectionGeneration,
        reference,
      }, nextOffset, controller.signal);
      setContent((current) => current + page.content);
      setNextOffset(page.endOffset);
      setHasMore(page.hasMore);
    } catch {
      setError(t("transcriptBlockContent.unableToLoadToolOutput"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <details className="workspaceTranscriptToolOutput">
      <summary>{t("transcriptBlockContent.toolOutputBytes", { value1: reference.byteLength })}</summary>
      {content ? <pre>{content}</pre> : null}
      {error ? <span role="alert">{error}</span> : null}
      {hasMore ? (
        <button type="button" disabled={loading} onClick={() => { void loadMore(); }}>
          {loading
            ? t("transcriptBlockContent.loading")
            : t("transcriptBlockContent.loadNextValueKiB", {
                value1: TRANSCRIPT_CONTENT_RANGE_BYTES / 1024,
              })}
        </button>
      ) : null}
    </details>
  );
}

function ReferencedContent({ body }: Readonly<{ body: TranscriptBlock["body"] }>) {
  const reference = body.kind === "tool"
    ? body.summaryRef
    : typeof body.content === "object" && body.content !== null && "sourceRef" in body.content
      ? body.content.sourceRef
      : null;
  const refId = typeof reference === "object" && reference !== null && "refId" in reference
    ? String(reference.refId)
    : "";
  const revision = typeof reference === "object" && reference !== null && "revision" in reference
    ? String(reference.revision)
    : "";
  const bytes = typeof reference === "object" && reference !== null && "byteLength" in reference
    ? String(reference.byteLength)
    : "";
  return (
    <span
      className="workspaceTranscriptReference"
      data-transcript-ref-id={refId || undefined}
      data-transcript-ref-revision={revision || undefined}
    >
      {bytes ? `${bytes} bytes` : "Referenced content"}
    </span>
  );
}

export const TranscriptBlockRow = memo(function TranscriptBlockRow({
  store,
  blockId,
}: Readonly<{ store: TranscriptViewStore; blockId: string }>) {
  const block = useTranscriptBlock(store, blockId);
  if (block === null) return null;
  const body = block.body;
  const text = body.kind === "tool"
    ? (typeof body.summary === "string" ? body.summary : null)
    : contentText(body.content);
  if (body.kind === "userText") {
    return (
      <div className="workspaceTranscriptBlock workspaceTranscriptUser" data-block-id={block.blockId}>
        <div className="workspaceUserMessage">{text ?? <ReferencedContent body={body} />}</div>
      </div>
    );
  }
  if (body.kind === "assistantText") {
    return (
      <div className="workspaceTranscriptBlock workspaceTranscriptAssistant" data-block-id={block.blockId}>
        <div className="workspaceTerminalAnswer">
          {text === null ? <ReferencedContent body={body} /> : <MarkdownContent text={text} />}
        </div>
      </div>
    );
  }
  if (body.kind === "reasoning") {
    return (
      <details className="workspaceTranscriptBlock workspaceTranscriptReasoning" data-block-id={block.blockId}>
        <summary>Reasoning</summary>
        <div className="workspaceReasoningBody">
          {text === null ? <ReferencedContent body={body} /> : <MarkdownContent text={text} />}
        </div>
      </details>
    );
  }
  if (body.kind === "tool") {
    const outputReference = contentReference(body.outputRef);
    return (
      <div className="workspaceTranscriptBlock workspaceActivityGroup" data-block-id={block.blockId}>
        <SquareTerminal aria-hidden="true" />
        <span>
          {text ?? <ReferencedContent body={body} />}
          {outputReference ? (
            <TranscriptToolOutput
              key={`${outputReference.refId}:${outputReference.revision}`}
              store={store}
              reference={outputReference}
            />
          ) : null}
        </span>
      </div>
    );
  }
  return (
    <div className="workspaceTranscriptBlock workspaceStageSummary" data-block-id={block.blockId}>
      {text === null ? <ReferencedContent body={body} /> : <MarkdownContent text={text} />}
    </div>
  );
});

export const TranscriptLiveTail = memo(function TranscriptLiveTail({ live }: Readonly<{
  live: TranscriptLiveOverlay;
}>) {
  return (
    <div className="workspaceTranscriptLive" data-block-id={`live:${live.messageId}`}>
      {live.reasoning?.text ? (
        <details className="workspaceTranscriptReasoning">
          <summary>Reasoning</summary>
          <div className="workspaceReasoningBody"><MarkdownContent text={live.reasoning.text} /></div>
        </details>
      ) : null}
      {live.text ? <div className="workspaceAnswerText isStreaming">
        <LiveMarkdownContent text={live.text} finalized={false} />
      </div> : null}
    </div>
  );
});
