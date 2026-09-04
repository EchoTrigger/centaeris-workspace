import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { LoginForm } from "./LoginForm";
import { useModalDialog } from "./useModalDialog";

type SessionExpiredDialogProps = {
  open: boolean;
  user: { id: string; email: string } | undefined;
  onReauthenticated: () => void | Promise<void>;
  onContinue: () => void;
};

export function SessionExpiredDialog({ open, user, onReauthenticated, onContinue }: SessionExpiredDialogProps) {
  const [restored, setRestored] = useState(false);
  const dialogRef = useModalDialog({ open, onClose: () => {} });

  useEffect(() => {
    if (!open) setRestored(false);
  }, [open]);

  if (!open || !user) return null;

  return createPortal(<div className="sessionExpiredBackdrop" role="presentation">
    <section className="sessionExpiredDialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label={restored ? "登录已恢复" : "重新登录"} tabIndex={-1}>
      {restored ? <div className="sessionExpiredRestored">
        <span aria-hidden="true"><Check /></span>
        <h1>登录已恢复</h1>
        <p>当前页面和未保存内容都已保留。刚才失败的操作没有自动重试。</p>
        <button autoFocus className="primary" type="button" onClick={onContinue}>返回继续</button>
      </div> : <LoginForm
        initialEmail={user.email}
        expectedUserId={user.id}
        heading="登录已过期"
        description="重新登录后继续当前工作，未保存内容仍留在这里。"
        submitLabel="重新登录"
        onAuthenticated={async () => {
          await onReauthenticated();
          setRestored(true);
        }}
      />}
    </section>
  </div>, document.body);
}
