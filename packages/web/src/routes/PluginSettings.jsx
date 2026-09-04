import { useEffect, useRef, useState } from "react";
import { Blocks, ChevronRight } from "lucide-react";
import { apiJson, jsonOptions } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function credentialKey(pluginName, credentialRef) {
  return `${pluginName}:${credentialRef}`;
}

function pluginErrors(plugin) {
  const messages = {
    plugin_manifest_invalid: "插件文件或说明无效，请更新或修复安装包。",
    plugin_credentials_unavailable: "无法读取插件凭据配置，请修复插件声明。",
    workspace_mcp_catalog_unavailable: "MCP 声明无法校验，请检查插件契约或 Runtime 服务。",
    workspace_hook_catalog_unavailable: "Hooks 无法校验，请检查插件声明或 Runtime 服务。",
    plugin_inspection_unavailable: "插件详情暂时不可用，请重试。",
  };
  return plugin.errors.map((code) => messages[code] || code).join(" ");
}

function canEnable(plugin) {
  return plugin.errors.length === 0 && plugin.mcpServers !== null && plugin.hooks !== null;
}

export default function PluginSettings({ workspace, isSuperuser }) {
  const [plugins, setPlugins] = useState(null);
  const [credentials, setCredentials] = useState(null);
  const [credentialError, setCredentialError] = useState("");
  const [credentialRevision, setCredentialRevision] = useState(0);
  const [expandedPluginNames, setExpandedPluginNames] = useState([]);
  const [busyPlugin, setBusyPlugin] = useState("");
  const [busyCredential, setBusyCredential] = useState("");
  const [credentialDrafts, setCredentialDrafts] = useState({});
  const [deleteCredential, setDeleteCredential] = useState(null);
  const [error, setError] = useState("");
  const pluginRowsRef = useRef(null);
  const activeWorkspace = useRef(workspace?.id);
  activeWorkspace.current = workspace?.id;
  const canManage = ["owner", "admin"].includes(workspace?.role);
  const hasExpandedPlugins = expandedPluginNames.length > 0;

  useEffect(() => {
    if (!hasExpandedPlugins || deleteCredential) return undefined;
    function collapseOutside(event) {
      if (!pluginRowsRef.current?.contains(event.target)) setExpandedPluginNames([]);
    }
    document.addEventListener("pointerdown", collapseOutside, true);
    return () => document.removeEventListener("pointerdown", collapseOutside, true);
  }, [hasExpandedPlugins, deleteCredential]);

  useEffect(() => {
    let active = true;
    setPlugins(null);
    setBusyPlugin("");
    setError("");
    if (!workspace?.id) return () => { active = false; };
    apiJson(`/api/workspaces/${workspace.id}/plugins`)
      .then((result) => {
        if (!active) return;
        setPlugins(result.plugins);
        setExpandedPluginNames((current) => current.filter((name) => result.plugins.some((plugin) => plugin.name === name)));
        for (const plugin of result.plugins) {
          apiJson(`/api/workspaces/${workspace.id}/plugins/${plugin.name}`)
            .then(({ plugin: detail }) => {
              if (!active) return;
              setPlugins((items) => items.map((item) => item.name === detail.name && item.packageDigest === detail.packageDigest
                ? { ...detail, enabled: item.enabled } : item));
            })
            .catch(() => {
              if (!active) return;
              setPlugins((items) => items.map((item) => item.name === plugin.name
                ? { ...item, errors: [...item.errors, "plugin_inspection_unavailable"] } : item));
            });
        }
      })
      .catch((requestError) => active && setError(errorText(requestError)));
    return () => { active = false; };
  }, [workspace?.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The revision is the retry button's explicit credential refresh signal.
  useEffect(() => {
    let active = true;
    setCredentials(null);
    setCredentialError("");
    setCredentialDrafts({});
    if (!isSuperuser) return () => { active = false; };
    apiJson("/api/admin/mcp-bearer-credentials")
      .then((result) => active && setCredentials(result.credentials))
      .catch((requestError) => active && setCredentialError(errorText(requestError)));
    return () => { active = false; };
  }, [isSuperuser, credentialRevision]);

  async function setEnabled(plugin, enabled) {
    const workspaceId = workspace.id;
    setBusyPlugin(plugin.name);
    setError("");
    try {
      const result = await apiJson(
        `/api/workspaces/${workspace.id}/plugins/${plugin.name}`,
        jsonOptions("PATCH", { enabled }),
      );
      if (activeWorkspace.current !== workspaceId) return;
      setPlugins((items) => items?.map((item) => item.name === plugin.name
        ? enabled ? result.plugin : { ...item, enabled: false } : item));
    } catch (requestError) {
      if (activeWorkspace.current === workspaceId) setError(errorText(requestError));
    } finally {
      if (activeWorkspace.current === workspaceId) setBusyPlugin("");
    }
  }

  function updateCredentialDraft(key, patch) {
    setCredentialDrafts((current) => ({
      ...current,
      [key]: { secret: "", ...current[key], ...patch },
    }));
  }

  async function saveCredential(pluginName, credentialRef, existing) {
    const key = credentialKey(pluginName, credentialRef);
    const draft = credentialDrafts[key] || {};
    setBusyCredential(key);
    setCredentialError("");
    try {
      let result;
      if (existing) {
        result = await apiJson(
          `/api/admin/mcp-bearer-credentials/${existing.id}/rotate`,
          jsonOptions("POST", { secret: draft.secret || "" }),
        );
      } else {
        result = await apiJson("/api/admin/mcp-bearer-credentials", jsonOptions("POST", {
          pluginName,
          credentialRef,
          displayName: `${pluginName} · ${credentialRef}`,
          secret: draft.secret || "",
        }));
      }
      setCredentialDrafts((current) => ({ ...current, [key]: { secret: "" } }));
      setCredentials((items) => [...(items || []).filter((item) => item.id !== result.credential.id), result.credential]);
    } catch (requestError) {
      setCredentialError(errorText(requestError));
    } finally {
      setBusyCredential("");
    }
  }

  async function confirmDeleteCredential() {
    if (!deleteCredential) return;
    const key = credentialKey(deleteCredential.pluginName, deleteCredential.credentialRef);
    setBusyCredential(key);
    setCredentialError("");
    try {
      await apiJson(`/api/admin/mcp-bearer-credentials/${deleteCredential.id}`, { method: "DELETE" });
      setDeleteCredential(null);
      setCredentials((items) => items.filter((item) => item.id !== deleteCredential.id));
    } catch (requestError) {
      setCredentialError(errorText(requestError));
    } finally {
      setBusyCredential("");
    }
  }

  if (!workspace) return <div className="capabilitySettingsEmpty">没有可配置的工作区。</div>;

  return (
    <div className="pluginSettings">
      {error ? <div className="capabilitySettingsError" role="alert">无法读取插件：{error}</div> : null}
      {isSuperuser && credentialError ? <div className="capabilitySettingsError" role="alert">凭据操作失败：{credentialError} <button className="pluginEnableButton" type="button" disabled={Boolean(busyCredential)} onClick={() => setCredentialRevision((value) => value + 1)}>重新读取凭据</button></div> : null}
      {plugins === null && !error ? <div className="capabilitySettingsEmpty">正在读取插件…</div> : null}
      {plugins?.length === 0 && !error ? <div className="capabilitySettingsEmpty">当前发行版没有插件。</div> : null}
      <div className="pluginSettingsRows" ref={pluginRowsRef} role="list" aria-label="可用插件">
        {(plugins || []).map((plugin) => {
          const expanded = expandedPluginNames.includes(plugin.name);
          const detailId = `plugin-detail-${plugin.name}`;
          const credentialRefs = expanded ? [...new Set([
            ...(plugin.mcpCredentialRefs || []),
            ...(credentials || []).filter((item) => item.pluginName === plugin.name).map((item) => item.credentialRef),
          ])] : [];
          return <article className="pluginSettingsEntry" role="listitem" key={plugin.name}>
            <div className="pluginSettingsRow">
              <button className="pluginSettingsIdentity" type="button" id={`${detailId}-toggle`} aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpandedPluginNames((current) => current.includes(plugin.name) ? current.filter((name) => name !== plugin.name) : [...current, plugin.name])} aria-label={`查看 ${plugin.displayName} 详细信息`}>
                <Blocks aria-hidden="true" />
                <span><strong>{plugin.displayName}</strong><small>{plugin.shortDescription || plugin.name}</small><small role={plugin.errors.length ? "status" : undefined}>{plugin.errors.length ? pluginErrors(plugin) : canEnable(plugin) ? "声明校验通过" : "正在检查声明…"}</small></span>
                <ChevronRight aria-hidden="true" />
              </button>
              <button
                className={plugin.enabled ? "pluginEnableButton is-enabled" : "pluginEnableButton"}
                type="button"
                disabled={!canManage || busyPlugin === plugin.name || (!plugin.enabled && !canEnable(plugin))}
                aria-label={`${plugin.enabled ? "停用" : "启用"} ${plugin.displayName}`}
                aria-pressed={plugin.enabled}
                onClick={() => void setEnabled(plugin, !plugin.enabled)}
              >{busyPlugin === plugin.name ? "正在保存…" : plugin.enabled ? "已启用" : "启用"}</button>
            </div>
            <div className="pluginSettingsDetail" id={detailId} role="region" aria-labelledby={`${detailId}-toggle`} hidden={!expanded}>
              {expanded ? <>
                {plugin.errors.length ? <p className="capabilitySettingsError" role="alert">{pluginErrors(plugin)} 不影响其他插件；此插件仍可停用。</p> : null}

                <section className="pluginSettingsSection" aria-labelledby={`${detailId}-general-heading`}>
                  <h3 id={`${detailId}-general-heading`}>通用</h3>
                  <div className="pluginSettingsProperty">
                    <strong>能力</strong>
                    <p>{plugin.capabilities.length ? plugin.capabilities.join("、") : "未声明"}</p>
                  </div>
                </section>

                <section className="pluginSettingsSection" aria-labelledby={`${detailId}-connections-heading`}>
                  <h3 id={`${detailId}-connections-heading`}>连接</h3>
                  {plugin.mcpServers === null ? <p className="pluginSettingsMuted">MCP 连接信息尚未通过校验，不能视为无需连接。</p> : plugin.mcpServers.length ? <div className="pluginConnectionRows">{plugin.mcpServers.map((server) => <div className="pluginConnectionRow" key={server.id}>
                    <span><strong>{server.id}</strong><small>{server.transport.type === "streamableHttp" ? "网络服务" : "本地服务"}</small></span>
                    <em>{server.auth.type === "none" ? "无需配置" : isSuperuser && credentials === null ? "凭据状态未知" : (isSuperuser ? credentials.some((item) => item.pluginName === plugin.name && item.credentialRef === server.auth.credentialRef) : server.auth.credentialConfigured) ? "凭据已保存" : "需要凭证"}</em>
                  </div>)}</div> : <p className="pluginSettingsMuted">此插件无需额外连接。</p>}
                  {isSuperuser && credentialRefs.length ? <div className="pluginCredentialSection">
                    {credentialRefs.map((credentialRef) => {
                      const key = credentialKey(plugin.name, credentialRef);
                      const existing = credentials?.find((credential) => credential.pluginName === plugin.name && credential.credentialRef === credentialRef);
                      const draft = credentialDrafts[key] || {};
                      return <form className="pluginCredentialForm" key={credentialRef} onSubmit={(event) => {
                        event.preventDefault();
                        void saveCredential(plugin.name, credentialRef, existing);
                      }}>
                        <div><strong>{credentialRef}</strong><small>{existing ? `已配置 · v${existing.version}` : "尚未配置"}</small></div>
                        <input aria-label={`${credentialRef} Bearer Token`} type="password" autoComplete="new-password" placeholder={existing ? "新 Token 或 Bearer …" : "Token 或 Bearer …"} value={draft.secret || ""} onChange={(event) => updateCredentialDraft(key, { secret: event.target.value })} />
                        <button type="submit" disabled={credentials === null || busyCredential === key || !draft.secret}>{busyCredential === key ? "正在保存…" : existing ? "轮换" : "保存"}</button>
                        {existing ? <button type="button" className="is-danger" disabled={busyCredential === key} onClick={() => setDeleteCredential(existing)}>删除</button> : null}
                      </form>;
                    })}
                  </div> : null}
                </section>

                <details className="pluginDeveloperDetails">
                  <summary>开发者信息</summary>
                  <dl className="pluginDeveloperFacts">
                    <div><dt>Package</dt><dd>{plugin.name}</dd></div>
                    <div><dt>版本</dt><dd>{plugin.version}</dd></div>
                    <div><dt>SHA-256</dt><dd>{plugin.packageDigest}</dd></div>
                  </dl>
                  {plugin.hooks === null ? <p>Hooks 尚未通过校验。</p> : plugin.hooks.length ? <section className="pluginMcpSection">
                    <header><h3>Lifecycle Hooks</h3></header>
                    <div className="pluginMcpServers">{plugin.hooks.map((hook) => <article className="pluginMcpServer" key={hook.id}>
                      <header><strong>{hook.id}</strong><span>{hook.event}</span><em>{hook.timeoutMs} ms</em></header>
                      {hook.matcher ? <code>{hook.matcher}</code> : null}
                    </article>)}</div>
                  </section> : null}
                  {plugin.mcpServers?.length ? <section className="pluginMcpSection">
                    <header><h3>MCP Servers</h3></header>
                    <div className="pluginMcpServers">{plugin.mcpServers.map((server) => <article className="pluginMcpServer" key={server.id}>
                      <header><strong>{server.id}</strong><span>{server.transport.type === "streamableHttp" ? "Streamable HTTP" : "stdio"}</span><em>{server.auth.type === "none" ? "无鉴权" : server.auth.credentialRef}</em></header>
                      {server.transport.endpoint ? <code>{server.transport.endpoint}</code> : null}
                      <div className="pluginMcpTools" aria-label={`${server.id} 声明工具`}>{server.tools.map((tool) => <div key={tool.sourceName}>
                        <span><strong>{tool.name}</strong><small>{tool.sourceName}</small></span>
                      </div>)}</div>
                    </article>)}</div>
                  </section> : null}
                </details>
              </> : null}
            </div>
          </article>;
        })}
      </div>
      <ConfirmDialog
        open={Boolean(deleteCredential)}
        title="删除 Bearer 凭证？"
        message={deleteCredential ? `删除“${deleteCredential.displayName}”后，新 Run 将无法连接使用该凭证的 MCP Server。` : ""}
        confirmLabel="删除"
        busy={Boolean(deleteCredential && busyCredential === credentialKey(deleteCredential.pluginName, deleteCredential.credentialRef))}
        onCancel={() => setDeleteCredential(null)}
        onConfirm={() => void confirmDeleteCredential()}
      />
    </div>
  );
}
