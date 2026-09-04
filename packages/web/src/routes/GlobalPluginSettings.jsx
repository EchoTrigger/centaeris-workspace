import { useEffect, useRef, useState } from "react";
import { Boxes, Upload } from "lucide-react";
import { ApiError, apiJson } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";


const ERROR_MESSAGES = {
  plugin_already_installed: "插件已经安装。",
  plugin_archive_too_large: "这个 ZIP 超出插件安装限制。",
  plugin_credentials_configured: "请先删除这个插件的 MCP 凭证。",
  plugin_enabled_in_workspaces: "请先在所有工作区停用这个插件。",
  plugin_in_active_agent_runs: "仍有运行中或等待执行的任务使用这个插件。",
  plugin_lifecycle_unavailable: "插件目录或运行时暂时不可用。",
  plugin_lifecycle_request_invalid: "插件请求包含不支持的字段。",
  plugin_archive_invalid: "这个 ZIP 不是有效的插件包。",
  plugin_package_layout_invalid: "ZIP 中必须包含一个完整的插件目录。",
  plugin_package_invalid: "插件清单或资源校验失败。",
  plugin_not_installed: "插件尚未安装。",
};


function errorText(error) {
  return error instanceof ApiError
    ? ERROR_MESSAGES[error.message] || "无法完成插件操作。"
    : error instanceof Error ? error.message : String(error);
}


function removalBlocker(plugin) {
  if (plugin.enabledWorkspaceCount) return `${plugin.enabledWorkspaceCount} 个工作区仍在使用`;
  if (plugin.credentialCount) return `${plugin.credentialCount} 个凭证仍已保存`;
  if (!plugin.removable) return "运行中的任务正在使用";
  return "";
}


export default function GlobalPluginSettings() {
  const [plugins, setPlugins] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [removeTarget, setRemoveTarget] = useState(null);
  const uploadInputRef = useRef(null);

  useEffect(() => {
    let active = true;
    apiJson("/api/admin/plugins")
      .then((result) => active && setPlugins(result.plugins))
      .catch((requestError) => active && setError(errorText(requestError)));
    return () => { active = false; };
  }, []);

  async function remove(plugin) {
    const key = `${plugin.name}:remove`;
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const result = await apiJson(
        `/api/admin/plugins/${plugin.name}`,
        { method: "DELETE" },
      );
      void result;
      setPlugins((items) => items.filter((item) => item.name !== plugin.name));
      setNotice(`${plugin.displayName} 已移除。`);
      setRemoveTarget(null);
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setBusy("");
    }
  }

  async function upload(file) {
    if (!file) return;
    setBusy("upload");
    setError("");
    setNotice("");
    const body = new FormData();
    body.append("file", file);
    try {
      const result = await apiJson("/api/admin/plugins/upload", { method: "POST", body });
      const wasInstalled = plugins?.some((item) => item.name === result.plugin.name) ?? false;
      setPlugins((items) => {
        const current = items || [];
        const existing = current.findIndex((item) => item.name === result.plugin.name);
        if (existing < 0) return [...current, result.plugin];
        return current.map((item, index) => index === existing ? result.plugin : item);
      });
      setNotice(`${result.plugin.displayName} 已${wasInstalled ? "更新" : "安装"}。`);
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setBusy("");
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  }

  return <div className="globalPluginSettings">
    <div className="globalPluginUpload">
      <input
        ref={uploadInputRef}
        type="file"
        accept=".zip,application/zip"
        aria-label="选择插件 ZIP"
        onChange={(event) => void upload(event.target.files?.[0])}
      />
      <button type="button" disabled={Boolean(busy) || plugins === null} onClick={() => uploadInputRef.current?.click()}>
        <Upload aria-hidden="true" />
        {busy === "upload" ? "正在安装…" : "上传 ZIP"}
      </button>
    </div>
    {error ? <p className="capabilitySettingsError" role="alert">{error}</p> : null}
    {notice ? <p className="globalPluginNotice" role="status" aria-live="polite">{notice}</p> : null}
    {plugins === null && !error ? <div className="capabilitySettingsEmpty" role="status">正在读取全局插件…</div> : null}
    {plugins?.length === 0 ? <div className="capabilitySettingsEmpty">尚未安装插件。</div> : null}
    {plugins?.length ? <div className="globalPluginRows" role="list" aria-label="全局插件">
      {plugins.map((plugin) => {
        const blocker = removalBlocker(plugin);
        const actionBusy = busy.startsWith(`${plugin.name}:`);
        return <article className="globalPluginEntry" role="listitem" aria-busy={actionBusy} key={plugin.name}>
          <div className="globalPluginIdentity">
            <Boxes aria-hidden="true" />
            <span>
              <strong>{plugin.displayName}</strong>
              <code translate="no">{plugin.name}</code>
            </span>
          </div>
          <p>{plugin.shortDescription || "未提供说明。"}</p>
          <div className="globalPluginFacts">
            <span className="isInstalled">已安装</span>
            <small>版本 <b>{plugin.version}</b></small>
            {plugin.enabledWorkspaceCount ? <small>{plugin.enabledWorkspaceCount} 个工作区已启用</small> : null}
            {plugin.credentialCount ? <small>{plugin.credentialCount} 个凭证</small> : null}
            {plugin.errors?.includes("plugin_manifest_invalid") ? <small className="isError">清单无法读取</small> : null}
          </div>
          <div className="globalPluginActions">
            <button className="isDanger" type="button" disabled={actionBusy || Boolean(blocker)} title={blocker || undefined} aria-label={`移除 ${plugin.displayName}`} onClick={() => setRemoveTarget(plugin)}>移除</button>
          </div>
        </article>;
      })}
    </div> : null}
    <ConfirmDialog
      open={Boolean(removeTarget)}
      title="移除全局插件？"
      message={removeTarget ? `移除“${removeTarget.displayName}”后，所有工作区都无法再启用它；如需恢复，请重新上传插件 ZIP。` : ""}
      confirmLabel="移除"
      busy={Boolean(removeTarget && busy === `${removeTarget.name}:remove`)}
      onCancel={() => setRemoveTarget(null)}
      onConfirm={() => void remove(removeTarget)}
    />
  </div>;
}
