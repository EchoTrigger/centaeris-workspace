import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "../i18n";
import { MarkdownContent } from "../chat/MarkdownContent";
import { officeFileType } from "../chat/officeFormats.mjs";

const OfficePreview = lazy(() => import("./OfficePreview"));

export function DocumentPreview({ src, title, contentType = "", className = "" }) {
  const { t } = useTranslation();
  const [state, setState] = useState({ src: "", text: "", error: false });
  const office = Boolean(officeFileType(title));
  const text = !office && contentType.startsWith("text/");
  useEffect(() => {
    if (!text) return;
    const abort = new AbortController();
    void fetch(src, { credentials: "include", signal: abort.signal }).then(async (response) => {
      if (!response.ok) throw new Error("preview_unavailable");
      const value = await response.text();
      if (!abort.signal.aborted) setState({ src, text: value, error: false });
    }).catch(() => {
      if (!abort.signal.aborted) setState({ src, text: "", error: true });
    });
    return () => abort.abort();
  }, [src, text]);
  if (office) return <Suspense fallback={<div role="status">{t("officePreview.loading")}</div>}><OfficePreview src={src} title={title} className={className} /></Suspense>;
  if (!text) return <iframe className={className} src={src} title={title} />;
  if (state.src !== src) return <div role="status">{t("workspaceContextPanel.loadingReferenceFile")}</div>;
  if (state.error) return <div role="alert">{t("appRoute.unableToLoadThisFile")}</div>;
  return <div className={`documentTextPreview ${className}`}>{contentType.split(";", 1)[0] === "text/markdown"
    ? <MarkdownContent text={state.text} /> : <pre>{state.text}</pre>}</div>;
}
