import { useEffect, useState } from "react";
import { ArrowRight, Building2, LoaderCircle } from "lucide-react";
import { useNavigate } from "react-router";
import { ApiError, apiJson, apiResponse, clearCsrfToken, isAuthenticationRequired, jsonOptions } from "../api";
import { LoginForm } from "../components/LoginForm";

const ERRORS = {
  invitation_not_found: "这个邀请链接无效或已经使用。",
  invitation_expired: "这个邀请链接已经过期，请联系工作区管理员重新签发。",
  invitation_not_pending: "这个邀请已经处理，不能再次使用。",
  invitation_account_mismatch: "当前登录账号与邀请邮箱不一致，请使用受邀账号登录。",
  invitation_account_inactive: "受邀账号当前不可用。",
  invitation_account_created_concurrently: "账号状态刚刚发生变化，请刷新后重新接受邀请。",
  invitation_account_setup_required: "请填写姓名和密码。",
  password_invalid: "密码不符合当前安全策略。",
  workspace_member_exists: "这个账号已经是该工作区成员。",
  workspace_unavailable: "这个工作区当前不可加入。",
};

function errorText(error) {
  const message = error instanceof Error ? error.message : String(error);
  return ERRORS[message] || message;
}

function roleLabel(role) {
  return role === "admin" ? "管理员" : "成员";
}

export default function InvitationActivationRoute() {
  const navigate = useNavigate();
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("token") || "");
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [loginRequired, setLoginRequired] = useState(false);
  const [accountMismatch, setAccountMismatch] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, "", "/activate");
  }, []);

  useEffect(() => {
    let active = true;
    async function load() {
      if (!token) {
        setError("这个邀请链接缺少 token。");
        setLoading(false);
        return;
      }
      try {
        const result = await apiJson("/api/invitations/preview", jsonOptions("POST", { token }));
        if (active) setPreview(result);
      } catch (requestError) {
        if (active) setError(errorText(requestError));
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [token]);

  async function accept(event) {
    event.preventDefault();
    if (!preview || busy) return;
    if (!preview.accountExists && password !== passwordConfirmation) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = preview.accountExists ? { token } : { token, name, password };
      const result = await apiJson("/api/invitations/accept", jsonOptions("POST", body));
      clearCsrfToken();
      navigate(`/w/${encodeURIComponent(result.workspaceId)}/app`, { replace: true });
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.message === "invitation_login_required") {
        setLoginRequired(true);
        return;
      }
      if (requestError instanceof ApiError && requestError.message === "invitation_account_mismatch") {
        setAccountMismatch(true);
        setError(errorText(requestError));
        return;
      }
      setError(errorText(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function switchAccount() {
    if (!preview || busy) return;
    setBusy(true);
    setError("");
    try {
      await apiResponse("/api/logout", { method: "POST" });
    } catch (requestError) {
      if (!isAuthenticationRequired(requestError)) {
        setError("切换账号失败，请重试。");
        setBusy(false);
        return;
      }
    }
    clearCsrfToken();
    setAccountMismatch(false);
    setNotice("");
    setLoginRequired(preview.accountExists);
    setBusy(false);
  }

  return <main className="activationPage">
    <section className="activationCard" aria-labelledby="activation-title">
      {loading ? <div className="activationState" aria-live="polite"><LoaderCircle aria-hidden="true" />正在读取邀请…</div> : null}
      {!loading && !preview ? <><h1 id="activation-title">无法接受邀请</h1><p className="activationError" role="alert">{error}</p></> : null}
      {!loading && preview ? <>
        <header>
          <span className="activationWorkspaceMark" aria-hidden="true"><Building2 /></span>
          <div><small>工作区邀请</small><h1 id="activation-title">加入 {preview.workspaceName}</h1></div>
        </header>
        <dl>
          <div><dt>账号</dt><dd>{preview.email}</dd></div>
          <div><dt>角色</dt><dd>{roleLabel(preview.role)}</dd></div>
          <div><dt>有效期至</dt><dd>{new Date(preview.expiresAt).toLocaleString("zh-CN")}</dd></div>
        </dl>
        {loginRequired ? <div className="activationLogin">
          <div className="activationLoginHeading"><h2>登录受邀账号</h2><span>使用 {preview.email} 登录，邀请仍保留在当前页面。</span></div>
          <LoginForm
            embedded
            emailReadOnly
            initialEmail={preview.email}
            submitLabel="登录受邀账号"
            onAuthenticated={() => {
              setLoginRequired(false);
              setAccountMismatch(false);
              setError("");
              setNotice("已登录受邀账号，请确认加入工作区。");
            }}
          />
        </div> : <form onSubmit={accept}>
          {!preview.accountExists ? <>
            <label>姓名<input autoFocus required maxLength={150} value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>设置密码<input type="password" autoComplete="new-password" minLength={15} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            <label>确认密码<input type="password" autoComplete="new-password" minLength={15} required value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} /></label>
            <p>密码至少 15 个字符。</p>
          </> : <p>{notice || "接受邀请需要使用上方受邀邮箱登录。"}</p>}
          {error ? <div className="activationError" role="alert">{error}</div> : null}
          {accountMismatch ? <button className="secondary" type="button" disabled={busy} onClick={switchAccount}>切换到受邀账号</button> : null}
          <button className="primary" type="submit" disabled={busy || (!preview.accountExists && (!name.trim() || !password || !passwordConfirmation))}>
            {busy ? "正在接受…" : "接受并进入工作区"}<ArrowRight aria-hidden="true" />
          </button>
        </form>}
      </> : null}
    </section>
  </main>;
}
