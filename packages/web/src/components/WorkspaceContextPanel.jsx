
import { useTranslation } from "../i18n";
import { Download, X } from "lucide-react";
import { useRef } from "react";
import { apiUrl } from "../api";

function CitationTextPreview({ content, locator }) {
  useTranslation();
  const lines = content.split(/\r?\n/);
  if (!Number.isInteger(locator?.startLine) || !Number.isInteger(locator?.endLine)) {
    return <pre>{content}</pre>;
  }
  const startIndex = Math.max(0, locator.startLine - 1);
  const endIndex = Math.min(lines.length, locator.endLine);
  if (startIndex >= endIndex) throw new Error("citation text locator is outside the preview content");
  const before = lines.slice(0, startIndex).join("\n");
  const evidence = lines.slice(startIndex, endIndex).join("\n");
  const after = lines.slice(endIndex).join("\n");
  return (
    <pre>
      {before ? `${before}\n` : ""}
      <mark>{evidence}</mark>
      {after ? `\n${after}` : ""}
    </pre>
  );
}

function FilePreviewPanel({ panel, browserWidthPx, onBrowserWidthChange, onClose, onReturn }) {
  const { t } = useTranslation();
  const dragRef = useRef(null);
  const moveResizeHandle = (clientX) => {
    const drag = dragRef.current;
    if (drag) onBrowserWidthChange(drag.widthPx + drag.clientX - clientX);
  };
  return (
    <aside className="workspaceContextPanel workspaceFilePreviewPanel" aria-label={t("workspaceContextPanel.filePreview")}>
      <div
        className="workspaceContextPanelResizeHandle"
        role="separator"
        aria-label={t("workspaceContextPanel.resizePreviewPanel")}
        aria-orientation="vertical"
        aria-valuemin={480}
        aria-valuemax={Math.max(480, Math.round(window.innerWidth * 0.75))}
        aria-valuenow={browserWidthPx}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") onBrowserWidthChange(browserWidthPx + 16);
          else if (event.key === "ArrowRight") onBrowserWidthChange(browserWidthPx - 16);
          else return;
          event.preventDefault();
        }}
        onPointerDown={(event) => {
          dragRef.current = { clientX: event.clientX, widthPx: browserWidthPx };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => moveResizeHandle(event.clientX)}
        onPointerUp={(event) => {
          moveResizeHandle(event.clientX);
          dragRef.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { dragRef.current = null; }}
      />
      <header className="workspaceContextPanelHeader filePreviewHeader">
        <nav aria-label={t("workspaceContextPanel.filePreviewPath")}>
          <button type="button" onClick={onReturn}>
            {panel.citationId ? t("workspaceContextPanel.library") : panel.originLabel || t("workspaceContextPanel.library")}
          </button>
          <span aria-hidden="true">/</span>
          <strong title={panel.displayName}>{panel.displayName}</strong>
        </nav>
        <div className="filePreviewActions">
          {panel.downloadUrl ? (
            <a href={apiUrl(panel.downloadUrl)} aria-label={t("workspaceContextPanel.downloadValue", { value1: panel.displayName })} title={t("workspaceContextPanel.download")}>
              <Download aria-hidden="true" />
            </a>
          ) : null}
          <button className="workspaceContextPanelClose" type="button" onClick={onClose} aria-label={t("attachmentCard.closePreview")} title={t("workspaceContextPanel.close")}>
            <X aria-hidden="true" />
          </button>
        </div>
      </header>
      {panel.status === "loading" ? <div className="filePreviewState">{t("workspaceContextPanel.loadingReferenceFile")}</div> : null}
      {panel.status === "error" ? <div className="filePreviewState isError" role="alert">{panel.error}</div> : null}
      {panel.status === "ready" ? (
        <div className="filePreviewLayout">
          <div className="filePreviewBody">
            {panel.preview.kind === "text" ? <CitationTextPreview content={panel.preview.content} locator={panel.locator} /> : null}
            {panel.preview.kind === "pdf" ? <iframe src={panel.preview.src} title={panel.displayName} /> : null}
            {panel.preview.kind === "image" ? <img src={panel.preview.src} alt={panel.displayName} /> : null}
            {panel.preview.kind === "unsupported" ? (
              <div className="filePreviewState">{t("workspaceContextPanel.inlinePreviewIsUnavailableForThisFileTypeUse")}</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </aside>
  );
}

export function WorkspaceContextPanel({ panel, browserWidthPx, onBrowserWidthChange, onClose, onReturn }) {
  useTranslation();
  if (panel.mode === "filePreview") {
    return <FilePreviewPanel panel={panel} browserWidthPx={browserWidthPx} onBrowserWidthChange={onBrowserWidthChange} onClose={onClose} onReturn={onReturn} />;
  }
  return null;
}
