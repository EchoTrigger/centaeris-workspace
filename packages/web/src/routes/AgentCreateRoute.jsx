import { useState } from "react";
import { useNavigate, useRevalidator, useRouteLoaderData } from "react-router";
import { apiJson, jsonOptions } from "../api";
import { AgentEditorModal } from "../shell/AgentEditorModal";
import { ShellPage } from "../shell/ShellPage";

export default function AgentCreateRoute() {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const { workspace } = useRouteLoaderData("workspace");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const draft = { name: "", description: "", instructions: "", avatarKind: "centaeris" };

  async function save(agentDraft) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await apiJson(`/api/workspaces/${workspace.id}/agents`, jsonOptions("POST", agentDraft));
      await revalidator.revalidate();
      navigate(`/w/${encodeURIComponent(workspace.id)}/agents/${encodeURIComponent(result.agent.id)}?new=1`);
    } catch (requestError) {
      setError(`无法创建代理：${requestError.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ShellPage initialTab="chat">
      <AgentEditorModal agent={draft} heading="创建私人代理" submitLabel="创建代理" busy={busy} error={error} onClose={() => navigate(-1)} onSave={save} />
    </ShellPage>
  );
}
