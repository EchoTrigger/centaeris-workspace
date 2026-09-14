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
import { TranscriptReferencedContent } from "./TranscriptReferencedContent";
import type {
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

function ReferencedContent({ store, reference, mode = "markdown" }: Readonly<{
  store: TranscriptViewStore; reference: TranscriptContentRef; mode?: "markdown" | "plain" | "output";
}>) {
  const identity = useSyncExternalStore(store.subscribeList, store.getListSnapshot, store.getListSnapshot);
  if (!identity.sessionId || !identity.projectionGeneration) return null;
  return <TranscriptReferencedContent
    key={`${identity.viewEpoch}:${identity.sessionId}:${identity.projectionGeneration}:${reference.refId}:${reference.revision}`}
    sessionId={identity.sessionId} projectionGeneration={identity.projectionGeneration} reference={reference} mode={mode}
  />;
}

function TranscriptToolOutput({ store, reference }: Readonly<{ store: TranscriptViewStore; reference: TranscriptContentRef }>) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return <details className="workspaceTranscriptToolOutput" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{t("transcriptBlockContent.toolOutput")}</summary>
    {open ? <ReferencedContent store={store} reference={reference} mode="output" /> : null}
  </details>;
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
  const reference = contentReference(body.kind === "tool" ? body.summaryRef
    : (body.content as { sourceRef?: unknown } | undefined)?.sourceRef);
  const referenced = reference ? <ReferencedContent store={store} reference={reference}
    mode={body.kind === "userText" || body.kind === "tool" ? "plain" : "markdown"} /> : null;
  if (body.kind === "userText") {
    return (
      <div className="workspaceTranscriptBlock workspaceTranscriptUser" data-block-id={block.blockId}>
        <div className="workspaceUserMessage">{text ?? referenced}</div>
      </div>
    );
  }
  if (body.kind === "assistantText") {
    return (
      <div className="workspaceTranscriptBlock workspaceTranscriptAssistant" data-block-id={block.blockId}>
        <div className="workspaceTerminalAnswer">
          {text === null ? referenced : <MarkdownContent text={text} />}
        </div>
      </div>
    );
  }
  if (body.kind === "reasoning") {
    return (
      <details className="workspaceTranscriptBlock workspaceTranscriptReasoning" data-block-id={block.blockId}>
        <summary>Reasoning</summary>
        <div className="workspaceReasoningBody">
          {text === null ? referenced : <MarkdownContent text={text} />}
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
          {text ?? referenced}
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
      {text === null ? referenced : <MarkdownContent text={text} />}
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
