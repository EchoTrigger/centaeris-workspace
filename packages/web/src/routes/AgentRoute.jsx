
import { useTranslation } from "../i18n";
import { useState } from "react";
import { Link, useNavigate, useParams, useRevalidator, useRouteLoaderData } from "react-router";
import { Bot, FileText, Lock, Pencil, Trash2 } from "lucide-react";
import { apiJson, jsonOptions } from "../api";
import { AgentEditorModal } from "../shell/AgentEditorModal";
import { AgentMark } from "../shell/AgentMark";
import { ShellPage } from "../shell/ShellPage";

export default function AgentRoute() {
  const { t } = useTranslation();
  const { agentId } = useParams();
  const { workspace, agents } = useRouteLoaderData("workspace");
  const agent = agents.find((item) => item.id === agentId);
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const base = `/w/${encodeURIComponent(workspace.id)}`;

  if (!agent) {
    return <ShellPage initialTab="chat"><div className="shEmptyPage"><Bot aria-hidden="true" /><h1>{t("agentRoute.agentNotFound")}</h1><Link to={`${base}/app`}>{t("router.backToWorkspaces")}</Link></div></ShellPage>;
  }

  async function save(nextAgent) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await apiJson(`/api/agents/${agent.id}`, jsonOptions("PATCH", nextAgent));
      await revalidator.revalidate();
      setEditing(false);
    } catch (requestError) {
      setError(t("agentRoute.unableToSaveAgentValue", { value1: requestError.message }));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await apiJson(`/api/agents/${agent.id}`, { method: "DELETE" });
      await revalidator.revalidate();
      navigate(`${base}/app`);
    } catch (requestError) {
      setError(requestError.message === "agent_has_active_agent_run" ? t("agentRoute.thisAgentHasActiveConversationsFinishOrStopThem") : t("agentRoute.unableToMoveToTrashValue", { value1: requestError.message }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ShellPage initialTab="chat">
      <div className="shAgentTopbar">
        <span>{agent.name}</span><span><Lock aria-hidden="true" />{" "}{t("agentRoute.private")}</span>
        <Link to={`${base}/agents/${encodeURIComponent(agent.id)}`}>{t("agentRoute.openConversation")}</Link>
      </div>
      {error ? <div className="errorBanner" role="alert">{error}</div> : null}
      <article className="shAgentPage">
        <header className="shAgentPageHeader">
          <AgentMark className="shAgentPageIcon" agent={agent} />
          <div><h1>{agent.name}</h1><p><Lock aria-hidden="true" />{t("agentRoute.onlyYouCanSeeThis")}</p></div>
        </header>
        <p className="shAgentLead">{agent.description || t("agentRoute.noDescriptionYet")}</p>
        <section className="shAgentSoulPreview" aria-labelledby="agentSoulHeading">
          <header>
            <span><FileText aria-hidden="true" /></span>
            <div><small>Instructions</small><h2 id="agentSoulHeading" translate="no">SOUL.md</h2></div>
          </header>
          <p>{agent.instructions || t("agentRoute.noInstructionsYetTheAgentWillUseItsDefault")}</p>
        </section>
        <div className="shAgentSettingsActions">
          <button className="shQuietButton" type="button" onClick={() => setEditing(true)}><Pencil aria-hidden="true" />{t("agentRoute.editAgent")}</button>
          <button className="shQuietButton isDanger" type="button" disabled={busy} onClick={() => void remove()}><Trash2 aria-hidden="true" />{t("agentRoute.moveToTrash")}</button>
        </div>
      </article>
      {editing ? <AgentEditorModal agent={agent} heading={t("agentRoute.editAgent")} submitLabel={t("agentRoute.saveChanges")} busy={busy} error={error} onClose={() => setEditing(false)} onSave={save} /> : null}
    </ShellPage>
  );
}
