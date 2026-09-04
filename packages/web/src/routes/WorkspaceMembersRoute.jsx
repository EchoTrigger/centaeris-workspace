import { useCallback, useEffect, useState } from "react";
import { Copy, MoreHorizontal, UserPlus } from "lucide-react";
import { Link, Navigate, useNavigate, useRouteLoaderData } from "react-router";
import { ApiError, apiJson, jsonOptions } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { WorkspaceDialog } from "../components/WorkspaceDialog";
import { ShellPage } from "../shell/ShellPage";
import { redirectAfterWorkspaceNotFound } from "../workspaceAccess";

const ADMIN_ROLES = new Set(["owner", "admin"]);

const ERROR_MESSAGES = {
  workspace_member_exists: "该账号已经是当前工作区成员。",
  workspace_member_role_unchanged: "成员角色没有变化。",
  workspace_member_self_operation_forbidden: "不能对自己的成员身份执行此操作。",
  workspace_owner_transfer_required: "所有者只能通过转让所有权来变更。",
  workspace_owner_reauthentication_failed: "当前密码不正确。",
  workspace_invitation_not_pending: "邀请状态已经发生变化。",
};

function errorText(error) {
  const message = error instanceof Error ? error.message : String(error);
  return ERROR_MESSAGES[message] || message;
}

function roleLabel(role) {
  return { owner: "所有者", admin: "管理员", member: "成员" }[role] || role;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function WorkspaceMembersRoute({ embedded = false } = {}) {
  const { user } = useRouteLoaderData("authenticated");
  const { workspace } = useRouteLoaderData("workspace");
  const navigate = useNavigate();
  const base = `/w/${encodeURIComponent(workspace.id)}`;
  const canManageWorkspace = ADMIN_ROLES.has(workspace.role);
  const [members, setMembers] = useState(null);
  const [invitations, setInvitations] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [notice, setNotice] = useState(null);
  const [busyKeys, setBusyKeys] = useState(() => new Set());
  const [removeTarget, setRemoveTarget] = useState(null);
  const [transferTarget, setTransferTarget] = useState(null);
  const [transferPassword, setTransferPassword] = useState("");
  const [inviteDialog, setInviteDialog] = useState(null);
  const [reissueTarget, setReissueTarget] = useState(null);
  const [revokeTarget, setRevokeTarget] = useState(null);

  const redirectForLostAccess = useCallback(async () => {
    await redirectAfterWorkspaceNotFound(workspace, navigate);
  }, [navigate, workspace]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setPageError("");
    try {
      const [memberResult, invitationResult] = await Promise.all([
        apiJson(`/api/workspaces/${encodeURIComponent(workspace.id)}/members`),
        apiJson(`/api/workspaces/${encodeURIComponent(workspace.id)}/invitations`),
      ]);
      if (!Array.isArray(memberResult.members) || !Array.isArray(invitationResult.invitations)) throw new Error("workspace_members_invalid");
      setMembers(memberResult.members);
      setInvitations(invitationResult.invitations);
    } catch (error) {
      if (error instanceof ApiError && error.message === "workspace_not_found") {
        await redirectForLostAccess();
        return;
      }
      if (quiet) setNotice({ kind: "error", text: `重新读取失败：${errorText(error)}` });
      else setPageError(errorText(error));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [redirectForLostAccess, workspace.id]);

  useEffect(() => {
    if (canManageWorkspace) void load();
  }, [canManageWorkspace, load]);

  useEffect(() => {
    if (!notice) return undefined;
    const timeout = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  function setBusy(key, busy) {
    setBusyKeys((current) => {
      const next = new Set(current);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function handleMutationError(error) {
    if (error instanceof ApiError && error.message === "workspace_not_found") {
      await redirectForLostAccess();
      return;
    }
    if (error instanceof ApiError && [404, 409].includes(error.status)) {
      await load(true);
      setNotice({ kind: "error", text: `状态已发生变化，已重新读取：${errorText(error)}` });
      return;
    }
    setNotice({ kind: "error", text: errorText(error) });
  }

  async function updateRole(member, role) {
    const key = `member:${member.membershipId}`;
    setBusy(key, true);
    try {
      const result = await apiJson(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/members/${encodeURIComponent(member.membershipId)}`,
        jsonOptions("PATCH", { role }),
      );
      const updated = result.member;
      setMembers((items) => items.map((item) => item.membershipId === updated.membershipId ? updated : item));
      setNotice({ kind: "success", text: `${updated.email} 已设为${roleLabel(updated.role)}。` });
    } catch (error) {
      await handleMutationError(error);
    } finally {
      setBusy(key, false);
    }
  }

  async function removeMember() {
    if (!removeTarget) return;
    const target = removeTarget;
    const key = `remove:${target.membershipId}`;
    setBusy(key, true);
    try {
      const result = await apiJson(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/members/${encodeURIComponent(target.membershipId)}`,
        { method: "DELETE" },
      );
      if (result.ok !== true) throw new Error("workspace_member_remove_result_invalid");
      setMembers((items) => items.filter((item) => item.membershipId !== target.membershipId));
      setRemoveTarget(null);
      setNotice({ kind: "success", text: `${target.email} 已从工作区移除。` });
    } catch (error) {
      await handleMutationError(error);
    } finally {
      setBusy(key, false);
    }
  }

  async function transferOwnership(event) {
    event.preventDefault();
    if (!transferTarget || !transferPassword) return;
    const target = transferTarget;
    const key = `transfer:${target.membershipId}`;
    setBusy(key, true);
    try {
      const result = await apiJson(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/owner-transfer`,
        jsonOptions("POST", {
          targetMembershipId: target.membershipId,
          currentPassword: transferPassword,
        }),
      );
      const owner = result.owner;
      const previousOwner = result.previousOwner;
      setMembers((items) => items.map((item) => {
        if (item.membershipId === owner.membershipId) return owner;
        if (item.membershipId === previousOwner.membershipId) return previousOwner;
        return item;
      }));
      setTransferTarget(null);
      setTransferPassword("");
      setNotice({ kind: "success", text: `所有权已转让给 ${owner.email}。` });
    } catch (error) {
      await handleMutationError(error);
    } finally {
      setBusy(key, false);
    }
  }

  async function issueInvitation(email, role) {
    setBusy("invite", true);
    try {
      const result = await apiJson(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/invitations`,
        jsonOptions("POST", { email: email.trim(), role }),
      );
      const invitation = result.invitation;
      if (typeof result.inviteUrl !== "string" || !result.inviteUrl) throw new Error("workspace_invite_url_invalid");
      setInvitations((items) => [...items.filter((item) => item.email !== invitation.email), invitation]);
      setInviteDialog({ email: invitation.email, role: invitation.role, inviteUrl: result.inviteUrl });
      setReissueTarget(null);
    } catch (error) {
      await handleMutationError(error);
    } finally {
      setBusy("invite", false);
    }
  }

  async function revokeInvitation() {
    if (!revokeTarget) return;
    const target = revokeTarget;
    const key = `revoke:${target.id}`;
    setBusy(key, true);
    try {
      const result = await apiJson(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/invitations/${encodeURIComponent(target.id)}`,
        { method: "DELETE" },
      );
      if (result.ok !== true) throw new Error("workspace_invitation_revoke_result_invalid");
      setInvitations((items) => items.filter((item) => item.id !== target.id));
      setRevokeTarget(null);
      setNotice({ kind: "success", text: `${target.email} 的邀请已撤销。` });
    } catch (error) {
      await handleMutationError(error);
    } finally {
      setBusy(key, false);
    }
  }

  async function copyInviteUrl() {
    try {
      await navigator.clipboard.writeText(inviteDialog.inviteUrl);
      setNotice({ kind: "success", text: "邀请链接已复制。" });
    } catch (error) {
      setNotice({ kind: "error", text: `无法复制邀请链接：${errorText(error)}` });
    }
  }

  if (!canManageWorkspace) {
    return <Navigate replace to={`${base}/app`} state={{ workspaceNotice: "你没有权限访问工作区设置。" }} />;
  }

  const actorRole = members?.find((member) => member.userId === String(user.id))?.role || workspace.role;
  const inviteBusy = busyKeys.has("invite");
  const transferBusy = transferTarget ? busyKeys.has(`transfer:${transferTarget.membershipId}`) : false;
  const removeBusy = removeTarget ? busyKeys.has(`remove:${removeTarget.membershipId}`) : false;
  const revokeBusy = revokeTarget ? busyKeys.has(`revoke:${revokeTarget.id}`) : false;

  const content = <>
    <div className={`shWorkspaceSettingsPage ${embedded ? "isEmbedded" : ""}`}>
      <header className="shWorkspaceSettingsHeader">
        <div>
          <span>{workspace.name} · 工作区设置</span>
          <h1>成员与权限</h1>
        </div>
        <button className="shPrimaryButton" type="button" disabled={loading || Boolean(pageError)} onClick={() => setInviteDialog({ email: "", role: "member", inviteUrl: "" })}>
          <UserPlus aria-hidden="true" />邀请成员
        </button>
      </header>

      <nav className="shWorkspaceSettingsTabs" aria-label="权限设置">
        <span className="isActive" aria-current="page">成员与邀请</span>
        <Link to={`${base}/settings/groups`}>用户组</Link>
      </nav>

      {loading ? <div className="shWorkspaceSettingsState" aria-live="polite">正在读取成员与邀请…</div> : null}
      {!loading && pageError ? <div className="shWorkspaceSettingsState isError" role="alert">无法读取工作区设置：{pageError}<button type="button" onClick={() => void load()}>重新加载</button></div> : null}

      {!loading && !pageError && members ? <>
        <section className="shWorkspaceSettingsSection">
          <header><div><h2>成员</h2><p>{members.length} 位成员</p></div></header>
          <div className="shWorkspaceMemberList">
            {members.map((member) => {
              const isCurrent = member.userId === String(user.id);
              const canMutate = member.role !== "owner" && !isCurrent;
              const memberBusy = busyKeys.has(`member:${member.membershipId}`);
              return <div className="shWorkspaceMemberRow" key={member.membershipId}>
                <span className="shWorkspaceMemberAvatar" aria-hidden="true">{member.email.slice(0, 1).toUpperCase()}</span>
                <span className="shWorkspaceMemberIdentity"><strong>{member.email}{isCurrent ? "（你）" : ""}</strong><small>加入于 {formatDate(member.createdAt)}</small></span>
                {canMutate ? <select value={member.role} disabled={memberBusy} aria-label={`${member.email} 的角色`} onChange={(event) => void updateRole(member, event.target.value)}>
                  <option value="admin">管理员</option><option value="member">成员</option>
                </select> : <span className="shWorkspaceRoleLabel">{roleLabel(member.role)}</span>}
                {canMutate && !memberBusy ? <details className="shWorkspaceRowMenu">
                  <summary role="button" aria-label={`${member.email} 的成员操作`}><MoreHorizontal aria-hidden="true" /></summary>
                  <div>
                    {actorRole === "owner" ? <button type="button" onClick={(event) => { event.currentTarget.closest("details").removeAttribute("open"); setTransferPassword(""); setTransferTarget(member); }}>转让所有权</button> : null}
                    <button className="isDanger" type="button" onClick={(event) => { event.currentTarget.closest("details").removeAttribute("open"); setRemoveTarget(member); }}>移除成员</button>
                  </div>
                </details> : <span />}
              </div>;
            })}
          </div>
        </section>

        <section className="shWorkspaceSettingsSection">
          <header><div><h2>待接受邀请</h2><p>邀请链接只在签发时展示；之后可以重新签发或撤销。</p></div></header>
          {invitations.length ? <div className="shWorkspaceInvitationList">
            {invitations.map((invitation) => <div className="shWorkspaceInvitationRow" key={invitation.id}>
              <span className="shWorkspaceMemberIdentity"><strong>{invitation.email}</strong><small>创建于 {formatDate(invitation.createdAt)}</small></span>
              <span>{roleLabel(invitation.role)}</span>
              <small>{formatDate(invitation.expiresAt)} 过期</small>
              <span className="shWorkspaceInvitationActions">
                <button type="button" onClick={() => setReissueTarget(invitation)}>重新签发</button>
                <button type="button" onClick={() => setRevokeTarget(invitation)}>撤销</button>
              </span>
            </div>)}
          </div> : <div className="shWorkspaceSettingsEmpty">没有待接受的邀请。</div>}
        </section>
      </> : null}
    </div>

    {notice ? <div className={`shWorkspaceToast ${notice.kind === "error" ? "isError" : ""}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div> : null}

    {inviteDialog ? <WorkspaceDialog
      title={inviteDialog.inviteUrl ? "邀请链接已生成" : "邀请成员"}
      description={inviteDialog.inviteUrl ? "该链接只在本次签发后展示。" : "生成一个 72 小时有效的邀请链接；系统不会代替你发送邮件。"}
      busy={inviteBusy}
      onClose={() => !inviteBusy && setInviteDialog(null)}
    >
      {inviteDialog.inviteUrl ? <div className="shWorkspaceInviteResult">
        <strong>{inviteDialog.email}</strong>
        <code>{inviteDialog.inviteUrl}</code>
        <p>相同邮箱此前未接受的邀请已失效。</p>
        <footer><button type="button" onClick={() => setInviteDialog(null)}>完成</button><button className="isPrimary" type="button" onClick={() => void copyInviteUrl()}><Copy aria-hidden="true" />复制链接</button></footer>
      </div> : <form onSubmit={(event) => { event.preventDefault(); void issueInvitation(inviteDialog.email, inviteDialog.role); }}>
        <label>邮箱<input autoFocus type="email" required value={inviteDialog.email} onChange={(event) => setInviteDialog({ ...inviteDialog, email: event.target.value })} /></label>
        <label>角色<select value={inviteDialog.role} onChange={(event) => setInviteDialog({ ...inviteDialog, role: event.target.value })}><option value="member">成员</option><option value="admin">管理员</option></select></label>
        <footer><button type="button" disabled={inviteBusy} onClick={() => setInviteDialog(null)}>取消</button><button className="isPrimary" type="submit" disabled={inviteBusy || !inviteDialog.email.trim()}>{inviteBusy ? "正在生成…" : "生成邀请链接"}</button></footer>
      </form>}
    </WorkspaceDialog> : null}

    {transferTarget ? <WorkspaceDialog title="转让工作区所有权" description={`确认将 ${workspace.name} 转让给 ${transferTarget.email}。完成后你将变为管理员。`} busy={transferBusy} onClose={() => { setTransferTarget(null); setTransferPassword(""); }}>
      <form onSubmit={transferOwnership}>
        <label>当前密码<input autoFocus type="password" autoComplete="current-password" required value={transferPassword} onChange={(event) => setTransferPassword(event.target.value)} /></label>
        <footer><button type="button" disabled={transferBusy} onClick={() => { setTransferTarget(null); setTransferPassword(""); }}>取消</button><button className="isDanger" type="submit" disabled={transferBusy || !transferPassword}>{transferBusy ? "正在转让…" : "确认转让"}</button></footer>
      </form>
    </WorkspaceDialog> : null}

    <ConfirmDialog open={Boolean(removeTarget)} title="移除成员" message={removeTarget ? `确认移除 ${removeTarget.email}？其 membership 和自定义组关系会被删除，历史事实仍会保留。` : ""} confirmLabel="移除" busy={removeBusy} onCancel={() => setRemoveTarget(null)} onConfirm={() => void removeMember()} />
    <ConfirmDialog open={Boolean(reissueTarget)} title="重新签发邀请" message={reissueTarget ? `为 ${reissueTarget.email} 签发新链接？旧链接会立即失效。` : ""} confirmLabel="重新签发" busy={inviteBusy} onCancel={() => setReissueTarget(null)} onConfirm={() => void issueInvitation(reissueTarget.email, reissueTarget.role)} />
    <ConfirmDialog open={Boolean(revokeTarget)} title="撤销邀请" message={revokeTarget ? `确认撤销 ${revokeTarget.email} 的邀请？现有链接会立即失效。` : ""} confirmLabel="撤销" busy={revokeBusy} onCancel={() => setRevokeTarget(null)} onConfirm={() => void revokeInvitation()} />
  </>;
  return embedded ? content : <ShellPage>{content}</ShellPage>;
}
