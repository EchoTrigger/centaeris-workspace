import { useNavigate, useSearchParams } from "react-router";
import { LoginForm } from "../components/LoginForm";

function safeReturnTo(value: string | null) {
  if (!value) return "/";
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
}

export default function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  return (
    <main className="login">
      <LoginForm
        initialEmail={searchParams.get("email") || ""}
        notice={searchParams.get("reset") === "1" ? "密码已更新，请使用新密码登录。" : ""}
        onAuthenticated={() => navigate(safeReturnTo(searchParams.get("next")), { replace: true })}
      />
    </main>
  );
}
