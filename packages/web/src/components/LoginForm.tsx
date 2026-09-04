import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { ApiError, apiJson, apiResponse, clearCsrfToken, jsonOptions } from "../api";

type LoginIdentity = { id: string; email: string };

type LoginFormProps = {
  initialEmail?: string;
  expectedUserId?: string;
  emailReadOnly?: boolean;
  embedded?: boolean;
  heading?: string;
  description?: string;
  submitLabel?: string;
  notice?: string;
  onAuthenticated: (user: LoginIdentity) => void | Promise<void>;
};

export function LoginBrand({ heading, description }: { heading: string; description: string }) {
  return <div className="loginBrand">
    <img src="/centaeris-mark.png" alt="" />
    <div><h1>{heading}</h1><p>{description}</p></div>
  </div>;
}

function loginError(error: unknown, reauthenticating: boolean) {
  if (error instanceof ApiError && error.message === "invalid_credentials") {
    return reauthenticating ? "密码不正确，请重试。" : "邮箱或密码不正确。";
  }
  if (error instanceof ApiError && error.message === "csrf_failed") return "安全校验失败，请重试。";
  return reauthenticating ? "重新登录失败，请重试。" : "登录失败，请重试。";
}

export function LoginForm({
  initialEmail = "",
  expectedUserId,
  emailReadOnly = false,
  embedded = false,
  heading = "登录",
  description = "Centaeris Workspace",
  submitLabel = "登录",
  notice = "",
  onAuthenticated,
}: LoginFormProps) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reauthenticating = Boolean(expectedUserId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await apiJson<{ user: LoginIdentity }>("/api/login", jsonOptions("POST", { email, password }));
      clearCsrfToken();
      if (!result.user?.id || !result.user.email) throw new Error("login_response_invalid");
      if (expectedUserId && result.user.id !== expectedUserId) {
        try {
          await apiResponse("/api/logout", { method: "POST" });
        } finally {
          clearCsrfToken();
          window.location.assign("/login");
        }
        return;
      }
      await onAuthenticated(result.user);
    } catch (requestError) {
      setError(loginError(requestError, reauthenticating));
    } finally {
      setBusy(false);
    }
  }

  return <form className={`loginForm${embedded ? " loginFormEmbedded" : ""}`} onSubmit={submit}>
    {!embedded ? <LoginBrand heading={heading} description={description} /> : null}
    {notice ? <div className="success" role="status">{notice}</div> : null}
    <label className="field">
      <span>邮箱</span>
      <input type="email" autoComplete="username" required readOnly={reauthenticating || emailReadOnly} value={email} onChange={(event) => setEmail(event.target.value)} />
    </label>
    <label className="field">
      <span>密码</span>
      <input autoFocus={reauthenticating || emailReadOnly} type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
    </label>
    {!reauthenticating && !embedded ? <div className="loginAuxiliary"><Link to="/forgot-password">忘记密码？</Link></div> : null}
    {error ? <div className="error" role="alert">{error}</div> : null}
    <button className="primary" type="submit" disabled={busy}>{busy ? "正在登录…" : submitLabel}</button>
  </form>;
}
