import {
  memo,
  useCallback,
  useSyncExternalStore,
  type ComponentType,
} from "react";
import { SquareTerminal } from "lucide-react";
import { MarkdownContent, StreamingMarkdownContent } from "./MarkdownContent";
import type {
  TranscriptBlock,
  TranscriptLiveOverlay,
  TranscriptViewStore,
} from "./transcriptViewStore";

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
    return (
      <div className="workspaceTranscriptBlock workspaceActivityGroup" data-block-id={block.blockId}>
        <SquareTerminal aria-hidden="true" />
        <span>{text ?? <ReferencedContent body={body} />}</span>
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
