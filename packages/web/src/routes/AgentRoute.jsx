import { useState } from "react";
import { Link, useNavigate, useParams, useRevalidator, useRouteLoaderData } from "react-router";
import { Bot, FileText, Lock, Pencil, Trash2 } from "lucide-react";
import { apiJson, jsonOptions } from "../api";
import { AgentEditorModal } from "../shell/AgentEditorModal";
import { AgentMark } from "../shell/AgentMark";
import { ShellPage } from "../shell/ShellPage";

export default function AgentRoute() {
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
    return <ShellPage initialTab="chat"><div className="shEmptyPage"><Bot aria-hidden="true" /><h1>找不到这个代理</h1><Link to={`${base}/app`}>返回工作区</Link></div></ShellPage>;
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
      setError(`无法保存代理：${requestError.message}`);
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
      setError(requestError.message === "agent_has_active_agent_run" ? "该代理仍有运行中的会话，完成或停止后再移入垃圾桶。" : `无法移入垃圾桶：${requestError.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ShellPage initialTab="chat">
      <div className="shAgentTopbar">
        <span>{agent.name}</span><span><Lock aria-hidden="true" /> 私人</span>
        <Link to={`${base}/agents/${encodeURIComponent(agent.id)}`}>打开会话</Link>
      </div>
      {error ? <div className="errorBanner" role="alert">{error}</div> : null}
      <article className="shAgentPage">
        <header className="shAgentPageHeader">
          <AgentMark className="shAgentPageIcon" agent={agent} />
          <div><h1>{agent.name}</h1><p><Lock aria-hidden="true" />仅你可见</p></div>
        </header>
        <p className="shAgentLead">{agent.description || "尚未填写说明。"}</p>
        <section className="shAgentSoulPreview" aria-labelledby="agentSoulHeading">
          <header>
            <span><FileText aria-hidden="true" /></span>
            <div><small>Instructions</small><h2 id="agentSoulHeading" translate="no">SOUL.md</h2></div>
          </header>
          <p>{agent.instructions || "尚未设置。代理将使用默认行为。"}</p>
        </section>
        <div className="shAgentSettingsActions">
          <button className="shQuietButton" type="button" onClick={() => setEditing(true)}><Pencil aria-hidden="true" />编辑代理</button>
          <button className="shQuietButton isDanger" type="button" disabled={busy} onClick={() => void remove()}><Trash2 aria-hidden="true" />移到垃圾桶</button>
        </div>
      </article>
      {editing ? <AgentEditorModal agent={agent} heading="编辑代理" submitLabel="保存更改" busy={busy} error={error} onClose={() => setEditing(false)} onSave={save} /> : null}
    </ShellPage>
  );
}
