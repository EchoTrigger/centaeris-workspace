
import { useTranslation } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useRevalidator, useRouteLoaderData } from "react-router";
import { ArrowLeft, LoaderCircle, RotateCcw, Trash2 } from "lucide-react";
import { apiJson, apiUrl } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { createChatViewStore } from "../chat/chatViewStore";
import { validateHistoryPage } from "../chat/sessionEvents";
import { VirtualAgentRunList } from "../chat/VirtualAgentRunList";
import { attachmentPreviewUrl } from "../chat/attachments.mjs";
import { ShellPage } from "../shell/ShellPage";

export default function TrashSessionRoute() {
  const { t } = useTranslation();
  const { sessionId = "" } = useParams();
  const { workspace, agents } = useRouteLoaderData("workspace");
  const base = `/w/${encodeURIComponent(workspace.id)}`;
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const storeRef = useRef(null);
  if (!storeRef.current) storeRef.current = createChatViewStore();
  const store = storeRef.current;
  const [session, setSession] = useState(null);
  const [assets, setAssets] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [purging, setPurging] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([
      apiJson(`/api/sessions/${encodeURIComponent(sessionId)}/history?limit=40`),
      apiJson(`/api/sessions/${encodeURIComponent(sessionId)}/assets`),
    ]).then(([historyResult, assetResult]) => {
      if (!active) return;
      const history = validateHistoryPage(historyResult, { sessionId, workspaceId: workspace.id });
      if (history.session.status === "active" && agents.some((agent) => agent.id === history.session.agentId)) {
        navigate(`${base}/agents/${encodeURIComponent(history.session.agentId)}?sessionId=${encodeURIComponent(sessionId)}`, { replace: true });
        return;
      }
      setSession(history.session);
      setAssets(assetResult.assets || []);
      store.replaceAll(history.agentRuns);
      setCursor(history.nextCursor);
      setHasMore(history.hasMore);
    }).catch((requestError) => {
      if (!active) return;
      if (requestError.status === 404) navigate(`${base}/app`, { replace: true });
      else setError(t("trashSessionRoute.unableToLoadConversationHistoryValue", { value1: requestError.message }));
    }).finally(() => active && setLoading(false));
    return () => { active = false; store.clear(); };
  }, [agents, base, navigate, sessionId, store, workspace.id, t]);

  async function loadOlder() {
    if (!cursor || !hasMore || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const result = await apiJson(`/api/sessions/${encodeURIComponent(sessionId)}/history?limit=40&before=${encodeURIComponent(cursor)}`);
      const page = validateHistoryPage(result, { sessionId, workspaceId: workspace.id });
      store.prependAgentRuns(page.agentRuns);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (requestError) {
      setError(t("trashSessionRoute.unableToLoadEarlierMessagesValue", { value1: requestError.message }));
    } finally {
      setLoadingOlder(false);
    }
  }

  async function restore() {
    if (!session || session.status !== "deleted" || restoring) return;
    setRestoring(true);
    setError("");
    try {
      await apiJson(`/api/sessions/${encodeURIComponent(session.id)}/restore`, { method: "POST" });
      await revalidator.revalidate();
      navigate(`${base}/agents/${encodeURIComponent(session.agentId)}?sessionId=${encodeURIComponent(session.id)}`);
    } catch (requestError) {
      if (requestError.status === 404 || requestError.status === 410) navigate(`${base}/app`, { replace: true });
      else if (requestError.message === "agent_deleted") setError(t("trashSessionRoute.restoreThisConversationSAgentFirst"));
      else if (requestError.message === "session_not_deleted") navigate(`${base}/agents/${encodeURIComponent(session.agentId)}?sessionId=${encodeURIComponent(session.id)}`, { replace: true });
      else setError(t("trashSessionRoute.unableToRestoreValue", { value1: requestError.message }));
    } finally {
      setRestoring(false);
    }
  }

  async function purge() {
    if (!session || purging) return;
    setPurging(true);
    setError("");
    try {
      await apiJson(`/api/sessions/${encodeURIComponent(session.id)}/trash`, { method: "DELETE" });
      await revalidator.revalidate();
      navigate(`${base}/app`, { replace: true });
    } catch (requestError) {
      if (requestError.status === 404 || requestError.status === 410 || requestError.message === "session_not_deleted") navigate(`${base}/app`, { replace: true });
      else setError(t("trashSessionRoute.unableToDeletePermanentlyValue", { value1: requestError.message }));
    } finally {
      setPurging(false);
    }
  }

  const parentActive = session && agents.some((agent) => agent.id === session.agentId);
  const openProtected = (path) => window.open(apiUrl(path), "_blank", "noopener,noreferrer");
  const remainingDays = session?.deletedAt ? Math.max(1, Math.ceil((new Date(session.deletedAt).valueOf() + 30 * 86400000 - Date.now()) / 86400000)) : null;

  return (
    <ShellPage>
      <div className="shDeletedTopbar"><Link to={`${base}/app`}><ArrowLeft aria-hidden="true" />{t("trashSessionRoute.back")}</Link><span>{session?.title || t("trashSessionRoute.deletedConversation")}</span></div>
      <div className="shDeletedBanner">
        <span>{parentActive ? remainingDays ? t("trash.remaining", { count: remainingDays }) : t("trash.inTrash") : t("trashSessionRoute.thisConversationIsHiddenWithItsDeletedAgentRestore")}</span>
        {session?.status === "deleted" && parentActive ? <button type="button" disabled={restoring} onClick={restore}>{restoring ? <LoaderCircle className="statusIcon" aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}{t("trashSessionRoute.restoreConversation")}</button> : null}
        {session?.status === "deleted" ? <button type="button" disabled={purging} onClick={() => setPurgeOpen(true)}><Trash2 aria-hidden="true" />{t("trashSessionRoute.deletePermanently")}</button> : null}
      </div>
      {error ? <div className="errorBanner" role="alert">{error}</div> : null}
      <section className="shTrashHistory" aria-label={t("trashSessionRoute.readOnlyConversationHistory")}>
        <VirtualAgentRunList
          store={store}
          sessionId={sessionId}
          loadingHistory={loading}
          hasMoreHistory={hasMore}
          loadingOlderHistory={loadingOlder}
          onLoadOlderHistory={loadOlder}
          assets={assets}
          onShowCitation={(_agentRunId, citation) => openProtected(`${citation.sourceUrl}/preview`)}
          onShowArtifact={(_agentRunId, artifact) => openProtected(artifact.downloadUrl)}
          onShowAttachment={(asset) => window.open(attachmentPreviewUrl(asset), "_blank", "noopener,noreferrer")}
        />
      </section>
      <ConfirmDialog open={purgeOpen} title={t("appRoute.deleteThisConversation")} busy={purging} onCancel={() => setPurgeOpen(false)} onConfirm={() => void purge()} />
    </ShellPage>
  );
}
