import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "../i18n";
import { MarkdownContent } from "./MarkdownContent";
import type { TranscriptContentRef } from "./transcriptContract";
import { TranscriptContentReader } from "./transcriptContentReader";
import { loadTranscriptContentRange } from "./transcriptContentRanges";

export function TranscriptReferencedContent({ sessionId, projectionGeneration, reference, mode }: Readonly<{
  sessionId: string;
  projectionGeneration: string;
  reference: TranscriptContentRef;
  mode: "markdown" | "plain" | "output";
}>) {
  const { t } = useTranslation();
  const [reader, setReader] = useState<TranscriptContentReader | null>(null);
  const { refId, revision, byteLength } = reference;
  useEffect(() => {
    const next = new TranscriptContentReader(
      (offset, signal) => loadTranscriptContentRange({
        sessionId, projectionGeneration, reference: { refId, revision, byteLength },
      }, offset, signal),
      mode === "output" ? "output" : "text",
    );
    setReader(next);
    void next.load();
    return () => { next.dispose(); };
  }, [sessionId, projectionGeneration, refId, revision, byteLength, mode]);
  return reader ? <Content reader={reader} mode={mode} /> : <span role="status">{t("transcriptBlockContent.loading")}</span>;
}

function Content({ reader, mode }: Readonly<{ reader: TranscriptContentReader; mode: "markdown" | "plain" | "output" }>) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  return <>
    {state.content ? (mode === "markdown" ? <MarkdownContent text={state.content} />
      : mode === "output" ? <pre>{state.content}</pre> : state.content) : null}
    {state.loading ? <span role="status">{t("transcriptBlockContent.loading")}</span> : null}
    {state.error ? <span role="alert">{t("transcriptBlockContent.unableToLoadContent")}
      <button type="button" onClick={() => { void reader.load(); }}>{t("codePreview.retry")}</button>
    </span> : null}
    {mode === "output" ? <div className="workspaceTranscriptOutputNavigation">
      <button type="button" disabled={state.loading || !state.hasPrevious} onClick={() => { void reader.previous(); }}>
        {t("transcriptBlockContent.previousOutput")}
      </button>
      <button type="button" disabled={state.loading || !state.hasMore} onClick={() => { void reader.next(); }}>
        {t("transcriptBlockContent.nextOutput")}
      </button>
    </div> : null}
  </>;
}
