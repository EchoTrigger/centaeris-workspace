import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, apiJson, jsonOptions } from "../api";
import { LoginBrand } from "../components/LoginForm";


function resetError(error: unknown) {
  if (!(error instanceof ApiError)) return "密码重置失败，请重试。";
  if (error.message === "account_password_reset_unavailable") return "管理员尚未配置邮件服务，请联系管理员重置密码。";
  if (error.message === "account_password_reset_invalid") return "链接无效或已失效，请重新申请。";
  if (error.message === "account_password_invalid") return "密码需至少 15 个字符，且不能过于常见或简单。";
  if (error.message === "account_password_unchanged") return "新密码不能与原密码相同。";
  if (error.message === "csrf_failed") return "安全校验失败，请重试。";
  return "密码重置失败，请重试。";
}

export function ForgotPasswordRoute() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await apiJson("/api/account/password-reset-requests", jsonOptions("POST", { email }));
      setSent(true);
    } catch (requestError) {
      setError(resetError(requestError));
    } finally {
      setBusy(false);
    }
  }

  if (sent) return <main className="login"><section className="loginForm">
    <LoginBrand heading="检查邮箱" description="密码重置" />
    <p className="loginMessage" role="status">如果该邮箱对应可用账号，重置链接将在稍后送达；请在邮件所示有效期内使用。</p>
    <Link className="secondary" to="/login">返回登录</Link>
  </section></main>;

  return <main className="login"><form className="loginForm" onSubmit={submit}>
    <LoginBrand heading="重置密码" description="获取一次性邮件链接" />
    <label className="field"><span>邮箱</span><input autoFocus type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
    {error ? <div className="error" role="alert">{error}</div> : null}
    <button className="primary" type="submit" disabled={busy}>{busy ? "正在发送…" : "发送重置链接"}</button>
    <div className="loginAuxiliary"><Link to="/login">返回登录</Link></div>
  </form></main>;
}

export function ResetPasswordRoute() {
  const navigate = useNavigate();
  const [credentials] = useState(() => {
    const values = new URLSearchParams(window.location.hash.slice(1));
    return { uid: values.get("uid") || "", token: values.get("token") || "" };
  });
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, "", "/reset-password");
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (password !== confirmation) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await apiJson("/api/account/password-resets", jsonOptions("POST", {
        uid: credentials.uid,
        token: credentials.token,
        newPassword: password,
      }));
      navigate("/login?reset=1", { replace: true });
    } catch (requestError) {
      setError(resetError(requestError));
    } finally {
      setBusy(false);
    }
  }

  if (!credentials.uid || !credentials.token) return <main className="login"><section className="loginForm">
    <LoginBrand heading="链接不可用" description="密码重置" />
    <p className="loginMessage" role="alert">链接不完整或已经从地址中移除，请重新申请。</p>
    <Link className="primary loginCenteredAction" to="/forgot-password">重新申请</Link>
  </section></main>;

  return <main className="login"><form className="loginForm" onSubmit={submit}>
    <LoginBrand heading="设置新密码" description="完成后所有旧登录状态都会失效" />
    <label className="field"><span>新密码</span><input autoFocus type="password" autoComplete="new-password" minLength={15} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
    <label className="field"><span>再次输入新密码</span><input type="password" autoComplete="new-password" minLength={15} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
    {error ? <div className="error" role="alert">{error}</div> : null}
    <button className="primary" type="submit" disabled={busy}>{busy ? "正在更新…" : "更新密码"}</button>
  </form></main>;
}
