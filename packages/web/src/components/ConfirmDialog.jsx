import { useId } from "react";
import { useModalDialog } from "./useModalDialog";

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "确认",
  cancelLabel = "取消",
  busy = false,
  onCancel,
  onConfirm,
}) {
  const titleId = useId();
  const dialogRef = useModalDialog({ open, busy, onClose: onCancel });

  if (!open) return null;
  return <div className="themeConfirmBackdrop" role="presentation" onMouseDown={() => !busy && onCancel()}>
    <section className="themeConfirmDialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
      <h2 id={titleId}>{title}</h2>
      {message ? <p>{message}</p> : null}
      <footer>
        <button type="button" autoFocus disabled={busy} onClick={onCancel}>{cancelLabel}</button>
        <button type="button" className="isDanger" disabled={busy} onClick={onConfirm}>{busy ? `${confirmLabel}中…` : confirmLabel}</button>
      </footer>
    </section>
  </div>;
}
