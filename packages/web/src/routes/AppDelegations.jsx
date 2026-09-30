import { useEffect, useState } from "react";
import { ApiError, apiJson, jsonOptions, requireWorkspaces } from "../api";
import { useTranslation } from "../i18n";
import "./app-delegations.css";

const SCOPES = ["assistant:use", "sessions:read", "sessions:create", "messages:submit", "attachments:write", "events:read", "artifacts:read", "runs:cancel"];

function requestErrorText(error, t) {
  const messages = {
    delegation_request_invalid: "appDelegations.invalidRequest",
    delegation_not_available: "appDelegations.notAvailable",
    business_app_request_invalid: "appDelegations.invalidApp",
    business_app_revoked: "appDelegations.appRevoked",
  };
  return t(error instanceof ApiError && messages[error.message] ? messages[error.message] : "appDelegations.requestFailed");
}

function requireApps(value) {
  if (!Array.isArray(value) || value.some(app => typeof app?.id !== "string" || !app.id || typeof app.name !== "string" || !["pending", "active", "revoked"].includes(app.status))) throw new Error("business_apps_invalid");
  return value;
}

function BusinessAppAdmin({ onAppsChanged }) {
  const { t } = useTranslation();
  const [apps, setApps] = useState(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    apiJson("/api/admin/business-apps").then(result => {
      const rows = requireApps(result.apps);
      if (active) setApps(rows);
    }).catch(error => { if (active) setError(requestErrorText(error, t)); });
    return () => { active = false; };
  }, [t]);

  async function register(event) {
    event.preventDefault();
    if (busy || !name.trim() || !apps) return;
    setBusy(true); setError("");
    try {
      const result = await apiJson("/api/admin/business-apps", jsonOptions("POST", { name: name.trim() }));
      requireApps([result.app]);
      setApps(items => [...items, result.app]); setName("");
    } catch (error) { setError(requestErrorText(error, t)); }
    finally { setBusy(false); }
  }

  async function update(app, status) {
    if (busy || app.status === "revoked") return;
    setBusy(true); setError("");
    try {
      const result = await apiJson(`/api/admin/business-apps/${encodeURIComponent(app.id)}`, jsonOptions("PATCH", { status }));
      requireApps([result.app]);
      setApps(items => items.map(item => item.id === app.id ? result.app : item));
      await onAppsChanged();
    } catch (error) { setError(requestErrorText(error, t)); }
    finally { setBusy(false); }
  }

  return <section className="appDelegationSection" aria-labelledby="business-app-admin-heading">
    <h2 id="business-app-admin-heading">{t("appDelegations.manageApps")}</h2>
    <p>{t("appDelegations.adminHint")}</p>
    <form className="appDelegationForm" onSubmit={register}>
      <label>{t("appDelegations.appName")}<input aria-label={t("appDelegations.appName")} value={name} onChange={event => setName(event.target.value)} required disabled={busy} /></label>
      <button type="submit" disabled={busy || !apps || !name.trim()}>{t("appDelegations.registerApp")}</button>
    </form>
    {error ? <p role="alert" className="accountSecurityError">{error}</p> : null}
    {apps === null && !error ? <p role="status">{t("appDelegations.loading")}</p> : null}
    {apps?.map(app => <article className="appDelegationRow" key={app.id}>
      <div><strong>{app.name}</strong><small>{t(`appDelegations.status.${app.status}`)}</small></div>
      <div className="appDelegationActions">
        {app.status === "pending" ? <button type="button" data-action="activate" disabled={busy} onClick={() => void update(app, "active")}>{t("appDelegations.activate")}</button> : null}
        {app.status !== "revoked" ? <button type="button" data-action="revoke" disabled={busy} onClick={() => void update(app, "revoked")}>{t("appDelegations.revokeApp")}</button> : null}
      </div>
    </article>)}
  </section>;
}

export default function AppDelegations({ isSuperuser = false }) {
  const { t, i18n } = useTranslation();
  const [apps, setApps] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [delegations, setDelegations] = useState(null);
  const [definitions, setDefinitions] = useState([]);
  const [loadedWorkspaceId, setLoadedWorkspaceId] = useState("");
  const [appId, setAppId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [definitionId, setDefinitionId] = useState("");
  const [scopes, setScopes] = useState([]);
  const [expiry, setExpiry] = useState("3600");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [oneTimeToken, setOneTimeToken] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([apiJson("/api/business-apps"), apiJson("/api/workspaces")]).then(([appResult, workspaceResult]) => {
      const rows = requireApps(appResult.apps);
      if (rows.some(app => app.status !== "active")) throw new Error("business_apps_invalid");
      const workspaceRows = requireWorkspaces(workspaceResult.workspaces);
      if (active) { setApps(rows); setWorkspaces(workspaceRows); }
    }).catch(error => { if (active) setError(requestErrorText(error, t)); });
    apiJson("/api/account/app-delegations").then(result => {
      if (!Array.isArray(result.delegations)) throw new Error("app_delegations_invalid");
      if (active) setDelegations(result.delegations);
    }).catch(error => { if (active) setError(requestErrorText(error, t)); });
    return () => { active = false; };
  }, [t]);

  useEffect(() => {
    if (!workspaceId) return undefined;
    let active = true;
    apiJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/available-agent-definitions`).then(result => {
      if (!Array.isArray(result.definitions) || result.definitions.some(item => !item.definitionId || typeof item.name !== "string")) throw new Error("agent_definitions_invalid");
      if (active) { setDefinitions(result.definitions); setLoadedWorkspaceId(workspaceId); }
    }).catch(error => { if (active) setError(requestErrorText(error, t)); });
    return () => { active = false; };
  }, [workspaceId, t]);

  const app = apps.find(item => item.id === appId);
  const workspace = workspaces.find(item => item.id === workspaceId);
  const definition = loadedWorkspaceId === workspaceId ? definitions.find(item => item.definitionId === definitionId) : null;
  const expiresInSeconds = Number(expiry);
  const canAuthorize = Boolean(app && workspace && definition && scopes.length && Number.isInteger(expiresInSeconds) && expiresInSeconds >= 300 && expiresInSeconds <= 86400 && !busy);

  async function authorize(event) {
    event.preventDefault();
    if (!canAuthorize) return;
    setBusy("authorize"); setError(""); setOneTimeToken(null); setCopied(false);
    try {
      const result = await apiJson("/api/account/app-delegations", jsonOptions("POST", { appId, workspaceId, definitionId, scopes, expiresInSeconds }));
      if (!result.delegation?.id || typeof result.accessToken !== "string" || !result.accessToken || result.tokenType !== "Bearer") throw new Error("app_delegation_invalid");
      setDelegations(items => [...(items || []), result.delegation]);
      setOneTimeToken({ delegationId: result.delegation.id, accessToken: result.accessToken });
    } catch (error) { setError(requestErrorText(error, t)); }
    finally { setBusy(""); }
  }

  async function revoke(delegation) {
    if (busy || delegation.revokedAt) return;
    setBusy(delegation.id); setError("");
    try {
      await apiJson(`/api/account/app-delegations/${encodeURIComponent(delegation.id)}`, { method: "DELETE" });
      setDelegations(items => items.map(item => item.id === delegation.id ? { ...item, revokedAt: new Date().toISOString() } : item));
      if (oneTimeToken?.delegationId === delegation.id) setOneTimeToken(null);
    } catch (error) { setError(requestErrorText(error, t)); }
    finally { setBusy(""); }
  }

  async function copyToken() {
    try { await navigator.clipboard.writeText(oneTimeToken.accessToken); setCopied(true); }
    catch { setError(t("appDelegations.copyFailed")); }
  }

  async function reloadApps() {
    const result = await apiJson("/api/business-apps");
    const rows = requireApps(result.apps);
    if (rows.some(app => app.status !== "active")) throw new Error("business_apps_invalid");
    setApps(rows);
  }

  function dateText(value) { return new Date(value).toLocaleString(i18n.language); }

  return <div className="accountSecuritySettings appDelegations">
    <header><h1>{t("appDelegations.title")}</h1></header>
    <p>{t("appDelegations.hint")}</p>
    {error ? <p className="accountSecurityError" role="alert">{error}</p> : null}
    <form className="appDelegationForm appDelegationSection" onSubmit={authorize}>
      <label>{t("appDelegations.application")}<select aria-label={t("appDelegations.application")} value={appId} onChange={event => setAppId(event.target.value)} disabled={Boolean(busy)} required>
        <option value="">{t("appDelegations.chooseApp")}</option>{apps.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <label>{t("appDelegations.workspace")}<select aria-label={t("appDelegations.workspace")} value={workspaceId} disabled={Boolean(busy)} required onChange={event => {
        setWorkspaceId(event.target.value); setDefinitionId(""); setDefinitions([]); setLoadedWorkspaceId(""); setError("");
      }}><option value="">{t("appDelegations.chooseWorkspace")}</option>{workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>{t("appDelegations.assistant")}<select aria-label={t("appDelegations.assistant")} value={definitionId} onChange={event => setDefinitionId(event.target.value)} disabled={Boolean(busy) || !workspaceId || loadedWorkspaceId !== workspaceId} required>
        <option value="">{t("appDelegations.chooseAssistant")}</option>{definitions.map(item => <option key={item.definitionId} value={item.definitionId}>{item.name}</option>)}
      </select></label>
      {workspaceId && loadedWorkspaceId === workspaceId && !definitions.length ? <p>{t("appDelegations.noAssistants")}</p> : null}
      <fieldset disabled={Boolean(busy)}><legend>{t("appDelegations.scopes")}</legend>{SCOPES.map(scope => <label className="appDelegationScope" key={scope}>
        <input type="checkbox" aria-label={scope} checked={scopes.includes(scope)} onChange={event => {
          const checked = event.target.checked;
          setScopes(items => checked ? SCOPES.filter(item => items.includes(item) || item === scope) : items.filter(item => item !== scope));
        }} />
        <span><code translate="no">{scope}</code><small>{t(`appDelegations.scope.${scope.replace(":", ".")}`)}</small></span>
      </label>)}</fieldset>
      <label>{t("appDelegations.expiry")}<input aria-label={t("appDelegations.expiry")} type="number" min="300" max="86400" step="1" value={expiry} onChange={event => setExpiry(event.target.value)} disabled={Boolean(busy)} required /><small>{t("appDelegations.expiryHint")}</small></label>
      <button type="submit" disabled={!canAuthorize}>{canAuthorize ? t("appDelegations.consent", { app: app.name, workspace: workspace.name, assistant: definition.name, scopes: scopes.join(", "), seconds: expiresInSeconds }) : t("appDelegations.authorize")}</button>
    </form>
    {oneTimeToken ? <section className="appDelegationSection" aria-labelledby="delegation-token-heading">
      <h2 id="delegation-token-heading">{t("appDelegations.tokenTitle")}</h2><p>{t("appDelegations.tokenHint")}</p>
      <pre className="appDelegationToken" translate="no">{oneTimeToken.accessToken}</pre>
      <div className="appDelegationActions"><button type="button" onClick={() => void copyToken()}>{t("appDelegations.copyToken")}</button><button type="button" onClick={() => { setOneTimeToken(null); setCopied(false); }}>{t("appDelegations.dismissToken")}</button></div>
      {copied ? <p role="status">{t("appDelegations.copied")}</p> : null}
    </section> : null}
    <section className="appDelegationSection" aria-labelledby="app-delegations-heading">
      <h2 id="app-delegations-heading">{t("appDelegations.yourGrants")}</h2>
      {delegations === null ? <p role="status">{t("appDelegations.loading")}</p> : !delegations.length ? <p>{t("appDelegations.noGrants")}</p> : delegations.map(item => <article className="appDelegationRow" key={item.id}>
        <div><strong>{item.appName}</strong><small>{item.workspaceName} / {item.definitionName}</small><code translate="no">{item.scopes.join(", ")}</code>
          <small>{t("appDelegations.created", { date: dateText(item.createdAt) })}</small><small>{t("appDelegations.expires", { date: dateText(item.expiresAt) })}</small>
          <small>{item.revokedAt ? t("appDelegations.status.revoked") : Date.parse(item.expiresAt) <= Date.now() ? t("appDelegations.expired") : t("appDelegations.status.active")}</small>
        </div>
        {!item.revokedAt ? <button type="button" disabled={Boolean(busy)} onClick={() => void revoke(item)}>{t("appDelegations.revokeGrant")}</button> : null}
      </article>)}
    </section>
    {isSuperuser ? <BusinessAppAdmin onAppsChanged={reloadApps} /> : null}
  </div>;
}
