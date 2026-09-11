import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?worker&url";
import { useTranslation } from "../i18n";
import { loadOfficePdf } from "../chat/loadOfficePdf.mjs";

GlobalWorkerOptions.workerSrc = workerUrl;

function PreviewDocument({ src, title }) {
  const { t } = useTranslation();
  const [document, setDocument] = useState(null);
  const [error, setError] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [paintedPage, setPaintedPage] = useState(0);
  const [pageText, setPageText] = useState("");
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const viewportRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    let task;
    void loadOfficePdf(src, { signal: controller.signal }).then(async (data) => {
      if (controller.signal.aborted) return;
      task = getDocument({ data, isEvalSupported: false });
      const pdf = await task.promise;
      if (!controller.signal.aborted) setDocument(pdf);
    }).catch((failure) => {
      if (!controller.signal.aborted) setError(failure.name === "TimeoutError" ? "officePreview.timeout" : "officePreview.error");
    });
    return () => { controller.abort(); void task?.destroy(); };
  }, [src]);

  useEffect(() => {
    const target = viewportRef.current;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(1, Math.floor(entry.contentRect.width - 32))));
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!document || !width) return;
    let disposed = false;
    let rendering;
    let page;
    void (async () => {
      page = await document.getPage(pageNumber);
      if (disposed) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width * zoom / base.width });
      // One page at a time, with a fixed pixel budget even for very large sheets.
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4_000_000 / (viewport.width * viewport.height)));
      // Keep the visible page and its layout intact until a complete replacement
      // is ready. Hiding it during paint can remove the scrollbar, change the
      // observed width and start an endless hide/resize/render cycle.
      const buffer = canvasRef.current.ownerDocument.createElement("canvas");
      buffer.width = Math.max(1, Math.floor(viewport.width * ratio));
      buffer.height = Math.max(1, Math.floor(viewport.height * ratio));
      rendering = page.render({ canvasContext: buffer.getContext("2d"), viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await rendering.promise;
      const text = await page.getTextContent();
      if (disposed) return;
      const canvas = canvasRef.current;
      canvas.width = buffer.width;
      canvas.height = buffer.height;
      canvas.getContext("2d").drawImage(buffer, 0, 0);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setPageText(text.items.map((item) => item.str || "").join(" "));
      setPaintedPage(pageNumber);
      viewportRef.current.scrollTop = 0;
      page.cleanup();
    })().catch(() => { if (!disposed) setError("officePreview.error"); });
    return () => { disposed = true; rendering?.cancel(); };
  }, [document, pageNumber, width, zoom]);

  return <>
    {document && !error ? <nav className="officePreviewControls" aria-label={t("officePreview.navigation")}>
      <button type="button" disabled={pageNumber === 1} onClick={() => setPageNumber((value) => value - 1)}>{t("officePreview.previous")}</button>
      <span>{t("officePreview.pageCount", { page: pageNumber, total: document.numPages })}</span>
      <button type="button" disabled={pageNumber === document.numPages} onClick={() => setPageNumber((value) => value + 1)}>{t("officePreview.next")}</button>
      <button type="button" aria-label={t("officePreview.zoomOut")} disabled={zoom <= 0.5} onClick={() => setZoom((value) => value - 0.25)}>−</button>
      <button type="button" aria-label={t("officePreview.fitWidth")} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
      <button type="button" aria-label={t("officePreview.zoomIn")} disabled={zoom >= 3} onClick={() => setZoom((value) => value + 0.25)}>+</button>
    </nav> : null}
    <div className="officePreviewViewport" ref={viewportRef}>
      {error ? <div className="officePreviewState" role="alert">{t(error)}</div> : <>
        {!paintedPage ? <div className="officePreviewState" role="status">{t("officePreview.loading")}</div> : null}
        <canvas ref={canvasRef} role="img" aria-label={t("officePreview.pageLabel", { title, page: paintedPage || pageNumber })} style={{ display: paintedPage ? "block" : "none" }} />
        <p className="srOnly">{paintedPage ? pageText : ""}</p>
      </>}
    </div>
  </>;
}

export default function OfficePreview({ src, title, className = "" }) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  return <section className={`officePreview ${className}`} aria-label={title}>
    <PreviewDocument key={`${src}:${attempt}`} src={src} title={title} />
    <button className="officePreviewReload" type="button" onClick={() => setAttempt((value) => value + 1)}>{t("officePreview.reload")}</button>
  </section>;
}
