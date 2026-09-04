import { useState } from "react";
import { Boxes, Cpu, Plug, Settings2, ShieldCheck, SlidersHorizontal, Users, UsersRound, X } from "lucide-react";
import { Link, Navigate, useLoaderData, useLocation, useNavigate, useOutletContext, useRouteLoaderData } from "react-router";
import { ApiError, apiJson, jsonOptions } from "../api";
import { useModalDialog } from "../components/useModalDialog";
import { useEnterStartsNewLine, writeEnterStartsNewLine } from "../preferences";
import ModelSettings from "./ModelSettings";
import GlobalPluginSettings from "./GlobalPluginSettings";
import PluginSettings from "./PluginSettings";
import WorkspaceGroupsRoute from "./WorkspaceGroupsRoute";
import WorkspaceMembersRoute from "./WorkspaceMembersRoute";

const ADMIN_ROLES = new Set(["owner", "admin"]);
const SECTIONS = {
  preferences: { label: "偏好", title: "偏好", icon: SlidersHorizontal, group: "", account: true },
  general: { label: "通用", title: "通用", icon: Settings2, group: "工作空间" },
  members: { label: "成员", title: "成员与权限", icon: Users, group: "工作空间" },
  groups: { label: "用户组", title: "用户组", icon: UsersRound, group: "工作空间", hiddenInNav: true },
  plugins: { label: "插件", title: "工作空间插件", icon: Plug, group: "工作空间" },
  security: { label: "安全", title: "安全", icon: ShieldCheck, group: "管理员", account: true },
  models: { label: "模型", title: "模型", icon: Cpu, group: "管理员", superuser: true },
  "global-plugins": { label: "平台插件", title: "平台插件", icon: Boxes, group: "管理员", superuser: true },
};

function Preferences({ userId }) {
  const enterStartsNewLine = useEnterStartsNewLine(userId);

  function updateEnterBehavior(event) {
    const enabled = event.target.checked;
    writeEnterStartsNewLine(userId, enabled);
  }

  return <div className="preferenceSettings">
    <section aria-labelledby="input-preferences-heading">
      <h1 id="input-preferences-heading">输入选项</h1>
      <label className="preferenceRow">
        <span><strong>使用 Enter 键开始新的一行</strong><small>适用于对话、评论和其他输入字段。按 <b>Cmd/Ctrl + Enter</b> 键发送。</small></span>
        <input type="checkbox" role="switch" aria-label="使用 Enter 键开始新的一行" checked={enterStartsNewLine} onChange={updateEnterBehavior} />
      </label>
    </section>
  </div>;
}

function Placeholder({ section }) {
  return <div className="workspaceSettingsPlaceholder">
    <span>暂未开放</span>
    <h1>{SECTIONS[section].title}</h1>
  </div>;
}

function AccountSecurity() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function update(setter) {
    return (event) => {
      setter(event.target.value);
      setError("");
      setNotice("");
    };
  }

  async function submit(event) {
    event.preventDefault();
    if (newPassword !== confirmation) {
      setError("两次输入的新密码不一致。");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await apiJson("/api/account/password", jsonOptions("PATCH", { currentPassword, newPassword }));
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setNotice("密码已更新。当前设备保持登录，其他登录会在下次请求时失效。");
    } catch (requestError) {
      const messages = {
        account_current_password_invalid: "当前密码不正确。",
        account_password_invalid: "新密码不符合当前安全策略。",
        account_password_unchanged: "新密码不能与当前密码相同。",
      };
      setError(requestError instanceof ApiError ? messages[requestError.message] || "无法更新密码，请重试。" : "无法更新密码，请重试。");
    } finally {
      setBusy(false);
    }
  }

  return <div className="accountSecuritySettings">
    <header>
      <h1>安全</h1>
    </header>
    <form className="accountSecurityForm" onSubmit={submit}>
      <label>当前密码<input autoComplete="current-password" type="password" value={currentPassword} onChange={update(setCurrentPassword)} required /></label>
      <label>新密码<input autoComplete="new-password" type="password" minLength={15} value={newPassword} onChange={update(setNewPassword)} required /><small>至少 15 个字符。</small></label>
      <label>确认新密码<input autoComplete="new-password" type="password" minLength={15} value={confirmation} onChange={update(setConfirmation)} required /></label>
      {error ? <p className="accountSecurityError" role="alert">{error}</p> : null}
      {notice ? <p className="accountSecurityNotice" role="status">{notice}</p> : null}
      <div className="accountSecurityActions"><button type="submit" disabled={busy || !currentPassword || !newPassword || !confirmation}>{busy ? "正在更新…" : "更新密码"}</button></div>
    </form>
  </div>;
}

function safeReturnTo(value, workspace) {
  if (typeof value !== "string" || !workspace) return null;
  return value.startsWith(`/w/${encodeURIComponent(workspace.id)}/`) ? value : null;
}

export default function SettingsPage() {
  const { user } = useRouteLoaderData("authenticated");
  const workspaceData = useRouteLoaderData("workspace");
  const accountData = useLoaderData();
  const navigate = useNavigate();
  const location = useLocation();
  const chat = useOutletContext();
  const isAccountRoute = location.pathname.startsWith("/settings/");
  const section = location.pathname.split("/").at(-1);
  const workspace = workspaceData?.workspace || (isAccountRoute ? accountData?.workspace : null);
  const home = workspace ? `/w/${encodeURIComponent(workspace.id)}/app` : "/";
  const closeTo = safeReturnTo(chat?.returnTo, workspace) || safeReturnTo(location.state?.returnTo, workspace) || home;
  const canManageWorkspace = Boolean(workspace && ADMIN_ROLES.has(workspace.role));
  const visibleSections = Object.entries(SECTIONS).filter(([, item]) => (
    item.account || (canManageWorkspace && (!item.superuser || user?.isSuperuser))
  ));
  const dialogRef = useModalDialog({ onClose: () => navigate(closeTo) });

  if (!SECTIONS[section]?.account && !canManageWorkspace) return <Navigate replace to={home} state={{ workspaceNotice: "你没有权限访问工作区设置。" }} />;
  if (!SECTIONS[section] || (SECTIONS[section].superuser && !user?.isSuperuser)) {
    return <Navigate replace to={isAccountRoute ? "/settings/preferences" : `${home.replace(/\/app$/, "")}/settings/general`} />;
  }

  const body = section === "preferences" ? <Preferences userId={user.id} />
    : section === "security" ? <AccountSecurity />
    : section === "members" ? <WorkspaceMembersRoute embedded />
      : section === "groups" ? <WorkspaceGroupsRoute embedded />
        : section === "plugins" ? <PluginSettings workspace={workspace} isSuperuser={Boolean(user?.isSuperuser)} />
          : section === "global-plugins" ? <GlobalPluginSettings />
          : section === "models" ? <ModelSettings onClose={() => navigate(closeTo)} onModelsChanged={() => chat?.onModelsChanged()} />
            : <Placeholder section={section} />;
  const content = ["plugins", "models", "global-plugins"].includes(section) ? <div className={`workspaceSettingsFeature ${section === "models" ? "isModels" : "isCapabilities"}`}>
    <header><h1>{SECTIONS[section].title}</h1></header>
    <div>{body}</div>
  </div> : body;
  return (
    <main className="settingsModalPage" onMouseDown={() => navigate(closeTo)}>
      <section className="settingsDialog workspaceSettingsDialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label={SECTIONS[section].title} tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <button className="quietCloseButton workspaceSettingsClose" type="button" onClick={() => navigate(closeTo)} aria-label="关闭"><X aria-hidden="true" /></button>
        <aside className="workspaceSettingsNav">
          {["", "工作空间", "管理员"].map((group) => {
            const entries = visibleSections.filter(([, item]) => item.group === group && !item.hiddenInNav);
            return entries.length ? <section key={group || "preferences"}>{group ? <h2>{group}</h2> : null}<nav>{entries.map(([key, item]) => {
              const Icon = item.icon;
              const target = item.account && !workspaceData
                ? `/settings/${key}${workspace ? `?${new URLSearchParams({ workspaceId: workspace.id })}` : ""}`
                : `/w/${encodeURIComponent(workspace.id)}/settings/${key}`;
              const active = key === section || (key === "members" && section === "groups");
              return <Link className={active ? "isActive" : ""} aria-current={active ? "page" : undefined} to={target} state={{ returnTo: closeTo }} key={key}><Icon aria-hidden="true" />{item.label}</Link>;
            })}</nav></section> : null;
          })}
        </aside>
        <div className="workspaceSettingsContent">
          <div className="workspaceSettingsScroll">{content}</div>
        </div>
      </section>
    </main>
  );
}
