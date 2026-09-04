import { Download, X } from "lucide-react";
import { useRef } from "react";
import { apiUrl } from "../api";

function CitationTextPreview({ content, locator }) {
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
  const dragRef = useRef(null);
  const moveResizeHandle = (clientX) => {
    const drag = dragRef.current;
    if (drag) onBrowserWidthChange(drag.widthPx + drag.clientX - clientX);
  };
  return (
    <aside className="workspaceContextPanel workspaceFilePreviewPanel" aria-label="文件预览">
      <div
        className="workspaceContextPanelResizeHandle"
        role="separator"
        aria-label="调整浏览栏宽度"
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
        <nav aria-label="文件预览路径">
          <button type="button" onClick={onReturn}>
            {panel.originLabel || "库"}
          </button>
          <span aria-hidden="true">/</span>
          <strong title={panel.displayName}>{panel.displayName}</strong>
        </nav>
        <div className="filePreviewActions">
          {panel.downloadUrl ? (
            <a href={apiUrl(panel.downloadUrl)} aria-label={`下载 ${panel.displayName}`} title="下载">
              <Download aria-hidden="true" />
            </a>
          ) : null}
          <button className="workspaceContextPanelClose" type="button" onClick={onClose} aria-label="关闭预览" title="关闭">
            <X aria-hidden="true" />
          </button>
        </div>
      </header>
      {panel.status === "loading" ? <div className="filePreviewState">正在读取引用文件…</div> : null}
      {panel.status === "error" ? <div className="filePreviewState isError" role="alert">{panel.error}</div> : null}
      {panel.status === "ready" ? (
        <div className="filePreviewLayout">
          <div className="filePreviewBody">
            {panel.preview.kind === "text" ? <CitationTextPreview content={panel.preview.content} locator={panel.locator} /> : null}
            {panel.preview.kind === "pdf" ? <iframe src={panel.preview.src} title={panel.displayName} /> : null}
            {panel.preview.kind === "image" ? <img src={panel.preview.src} alt={panel.displayName} /> : null}
            {panel.preview.kind === "unsupported" ? (
              <div className="filePreviewState">此文件类型暂不支持内嵌预览，请使用右上角下载。</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </aside>
  );
}

export function WorkspaceContextPanel({ panel, browserWidthPx, onBrowserWidthChange, onClose, onReturn }) {
  if (panel.mode === "filePreview") {
    return <FilePreviewPanel panel={panel} browserWidthPx={browserWidthPx} onBrowserWidthChange={onBrowserWidthChange} onClose={onClose} onReturn={onReturn} />;
  }
  return null;
}
