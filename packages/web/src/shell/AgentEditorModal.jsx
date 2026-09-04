import { useEffect, useRef, useState } from "react";
import { FileText, Lock, Pencil, X } from "lucide-react";
import { useModalDialog } from "../components/useModalDialog";
import { AgentMark } from "./AgentMark";

const AVATAR_CHOICES = [
  ["centaeris", "Centaeris"],
  ["banana", "none"],
];

export function AgentEditorModal({ agent, heading, submitLabel, busy = false, error = "", onClose, onSave }) {
  const [view, setView] = useState("profile");
  const [name, setName] = useState(agent.name || "");
  const [description, setDescription] = useState(agent.description || "");
  const [instructions, setInstructions] = useState(agent.instructions || "");
  const [avatarKind, setAvatarKind] = useState(agent.avatarKind);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const continueEditingRef = useRef(null);
  const dirty = name !== (agent.name || "")
    || description !== (agent.description || "")
    || instructions !== (agent.instructions || "")
    || avatarKind !== agent.avatarKind;
  const dialogRef = useModalDialog({
    open: view === "profile",
    busy,
    onClose: () => confirmingClose ? setConfirmingClose(false) : requestClose(),
  });

  useEffect(() => {
    if (confirmingClose) continueEditingRef.current?.focus();
  }, [confirmingClose]);

  function requestClose() {
    if (busy) return;
    if (dirty) setConfirmingClose(true);
    else onClose();
  }

  function submit(event) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;
    onSave({
      name: trimmedName,
      description: description.trim(),
      instructions: instructions.trim(),
      avatarKind,
    });
  }

  function reset() {
    setName(agent.name || "");
    setDescription(agent.description || "");
    setInstructions(agent.instructions || "");
    setAvatarKind(agent.avatarKind);
    setConfirmingClose(false);
    setView("profile");
  }

  if (view === "instructions") {
    return (
      <section
        className="shSoulDocumentPage libraryPreviewMain"
        aria-label={`${heading} SOUL.md`}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          setView("profile");
        }}
      >
        <header className="libraryPreviewHeader">
          <nav className="libraryNoteIdentity" aria-label="SOUL.md 地址">
            <button type="button" onClick={() => setView("profile")}>代理</button>
            <span aria-hidden="true">/</span>
            <strong translate="no">SOUL.md</strong>
            <small><Lock aria-hidden="true" />私人</small>
          </nav>
          <button className="shSoulDocumentDone" type="button" onClick={() => setView("profile")}>完成编辑</button>
        </header>
        <section className="libraryPreviewBody libraryNotePreview">
          <div className="libraryNoteEditor">
            <label className="srOnly" htmlFor="agentInstructions">代理指令</label>
            <textarea
              id="agentInstructions"
              name="agentInstructions"
              autoComplete="off"
              maxLength={16000}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder={"# 身份与职责\n\n写下这个代理应遵循的工作方式与行为边界…"}
              aria-label="代理指令"
            />
          </div>
        </section>
      </section>
    );
  }

  return (
    <div className="shModalBackdrop" role="presentation" onMouseDown={requestClose}>
      <form
        className="shAgentCreate"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        tabIndex={-1}
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="shModalClose quietCloseButton" type="button" disabled={busy} onClick={requestClose} aria-label="关闭"><X aria-hidden="true" /></button>

        <h1>{heading}</h1>
            <div className="shAgentIdentity">
              <AgentMark className="shAgentHeroMark" agent={{ avatarKind }} />
              <input
                className="shAgentNameInput"
                name="agentName"
                autoComplete="off"
                maxLength={255}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="为代理命名…"
                aria-label="代理名称"
              />
              <span className="shAgentPrivate"><Lock aria-hidden="true" />仅你可见</span>
            </div>

            <fieldset className="shAvatarChoices">
              <legend>选择头像</legend>
              {AVATAR_CHOICES.map(([kind, label]) => (
                <button
                  className={avatarKind === kind ? "isActive" : ""}
                  type="button"
                  aria-pressed={avatarKind === kind}
                  onClick={() => setAvatarKind(kind)}
                  key={kind}
                >
                  <AgentMark agent={{ avatarKind: kind }} />
                  <span>{label}</span>
                </button>
              ))}
            </fieldset>

            <label className="shCreateLabel" htmlFor="agentDescription">简介</label>
            <input
              className="shAgentDescriptionInput"
              id="agentDescription"
              name="agentDescription"
              autoComplete="off"
              maxLength={128}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="一句话说明它负责什么…"
              aria-label="代理简介"
            />

            <section className="shInstructionsSection" aria-labelledby="agentInstructionsHeading">
              <small id="agentInstructionsHeading">Instructions</small>
              <button className="shSoulCard" type="button" onClick={() => setView("instructions")} aria-label="编辑 SOUL.md">
                <span className="shSoulCardIcon"><FileText aria-hidden="true" /></span>
                <span className="shSoulCardCopy">
                  <strong translate="no">SOUL.md</strong>
                  <small>{instructions.trim().split("\n")[0] || "尚未设置。代理将使用默认行为。"}</small>
                </span>
                <span className="shSoulCardAction"><Pencil aria-hidden="true" />编辑</span>
              </button>
            </section>

            {error ? <div className="errorBanner" role="alert">{error}</div> : null}
            {confirmingClose ? <footer className="shAgentDiscardPrompt" role="alert">
              <span><strong>放弃未保存的更改？</strong><small>名称、简介、头像和 SOUL.md 草稿都会丢失。</small></span>
              <button ref={continueEditingRef} type="button" onClick={() => setConfirmingClose(false)}>继续编辑</button>
              <button className="isDanger" type="button" onClick={onClose}>放弃更改</button>
            </footer> : <footer>
              <span className="srOnly" role="status" aria-live="polite">{busy ? "正在保存代理…" : ""}</span>
              <button type="button" disabled={busy} onClick={reset}>重置</button>
              <button className="shPrimaryButton" type="submit" disabled={busy || !name.trim()}>{busy ? "保存中…" : submitLabel}</button>
            </footer>}
      </form>
    </div>
  );
}
