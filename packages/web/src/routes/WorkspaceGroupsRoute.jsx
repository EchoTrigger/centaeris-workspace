import { useCallback, useEffect, useState } from "react";
import { Plus, ShieldCheck, Trash2, UsersRound } from "lucide-react";
import { Link, Navigate, useNavigate, useRouteLoaderData } from "react-router";
import { ApiError, apiJson, jsonOptions } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ShellPage } from "../shell/ShellPage";
import { redirectAfterWorkspaceNotFound } from "../workspaceAccess";

const ADMIN_ROLES = new Set(["owner", "admin"]);
const ERRORS = {
  workspace_group_name_exists: "当前工作区已经有同名用户组。",
  workspace_group_name_unchanged: "用户组名称没有变化。",
  workspace_system_group_immutable: "系统动态组不能修改。",
  workspace_group_not_found: "用户组已经不存在。",
  workspace_member_not_found: "成员身份已经发生变化。",
};

function errorText(error) {
  const message = error instanceof Error ? error.message : String(error);
  return ERRORS[message] || message;
}

function roleLabel(role) {
  return { owner: "所有者", admin: "管理员", member: "成员" }[role] || role;
}

export default function WorkspaceGroupsRoute({ embedded = false } = {}) {
  const { workspace } = useRouteLoaderData("workspace");
  const navigate = useNavigate();
  const base = `/w/${encodeURIComponent(workspace.id)}`;
  const canManageWorkspace = ADMIN_ROLES.has(workspace.role);
  const [groups, setGroups] = useState(null);
  const [members, setMembers] = useState(null);
  const [selectedId, setSelectedId] = useState("");
  const [groupMemberIds, setGroupMemberIds] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [pageError, setPageError] = useState("");
  const [notice, setNotice] = useState(null);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [renameName, setRenameName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [busyKeys, setBusyKeys] = useState(() => new Set());
  const [deleteTarget, setDeleteTarget] = useState(null);

  function setBusy(key, busy) {
    setBusyKeys((current) => {
      const next = new Set(current);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  const lostAccess = useCallback(async () => {
    await redirectAfterWorkspaceNotFound(workspace, navigate);
  }, [navigate, workspace]);

  const load = useCallback(async () => {
    setLoading(true);
    setPageError("");
    try {
      const [groupResult, memberResult] = await Promise.all([
        apiJson(`/api/workspaces/${encodeURIComponent(workspace.id)}/groups`),
        apiJson(`/api/workspaces/${encodeURIComponent(workspace.id)}/members`),
      ]);
      if (!Array.isArray(groupResult.groups) || !Array.isArray(memberResult.members)) throw new Error("workspace_groups_invalid");
      const nextGroups = groupResult.groups;
      setGroups(nextGroups);
      setMembers(memberResult.members);
      setSelectedId((current) => nextGroups.some((group) => group.id === current) ? current : (nextGroups[0]?.id || ""));
    } catch (error) {
      if (error instanceof ApiError && error.message === "workspace_not_found") await lostAccess();
      else setPageError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, [lostAccess, workspace.id]);

  useEffect(() => {
    if (canManageWorkspace) void load();
  }, [canManageWorkspace, load]);

  useEffect(() => {
    if (!selectedId) {
      setGroupMemberIds(new Set());
      return undefined;
    }
    let active = true;
    setRosterLoading(true);
    apiJson(`/api/workspaces/${encodeURIComponent(workspace.id)}/groups/${encodeURIComponent(selectedId)}/members`)
      .then((result) => {
        if (active) {
          if (!Array.isArray(result.members)) throw new Error("workspace_group_members_invalid");
          setGroupMemberIds(new Set(result.members.map((member) => member.membershipId)));
        }
      })
      .catch(async (error) => {
        if (!active) return;
        if (error instanceof ApiError && error.message === "workspace_not_found") await lostAccess();
        else {
          setNotice({ kind: "error", text: errorText(error) });
          if (error instanceof ApiError && error.message === "workspace_group_not_found") await load();
        }
      })
      .finally(() => { if (active) setRosterLoading(false); });
    return () => { active = false; };
  }, [load, lostAccess, selectedId, workspace.id]);

  useEffect(() => {
    if (!notice) return undefined;
    const timeout = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  async function handleError(error) {
    if (error instanceof ApiError && error.message === "workspace_not_found") {
      await lostAccess();
      return;
    }
    if (error instanceof ApiError && [404, 409].includes(error.status)) await load();
    setNotice({ kind: "error", text: errorText(error) });
  }

  async function createGroup(event) {
    event.preventDefault();
    const key = "create";
    setBusy(key, true);
    try {
      const result = await apiJson(`/api/workspaces/${encodeURIComponent(workspace.id)}/groups`, jsonOptions("POST", { name: createName }));
      const group = result.group;
      setGroups((items) => [...items, group]);
      setSelectedId(group.id);
      setCreateName("");
      setCreating(false);
      setNotice({ kind: "success", text: `已创建用户组 ${group.name}。` });
    } catch (error) {
      await handleError(error);
    } finally {
      setBusy(key, false);
    }
  }

  async function renameGroup(event) {
    event.preventDefault();
    const selected = groups.find((group) => group.id === selectedId);
    if (!selected) return;
    const key = `rename:${selected.id}`;
    setBusy(key, true);
    try {
      const result = await apiJson(`/api/workspaces/${encodeURIComponent(workspace.id)}/groups/${encodeURIComponent(selected.id)}`, jsonOptions("PATCH", { name: renameName }));
      const group = result.group;
      setGroups((items) => items.map((item) => item.id === group.id ? group : item));
      setRenaming(false);
      setNotice({ kind: "success", text: `用户组已重命名为 ${group.name}。` });
    } catch (error) {
      await handleError(error);
    } finally {
      setBusy(key, false);
    }
  }

  async function toggleMember(member) {
    const group = groups.find((item) => item.id === selectedId);
    if (!group || group.kind !== "custom") return;
    const included = groupMemberIds.has(member.membershipId);
    const key = `member:${member.membershipId}`;
    setBusy(key, true);
    try {
      const result = await apiJson(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(member.membershipId)}`,
        { method: included ? "DELETE" : "PUT" },
      );
      if (result.ok !== true) throw new Error("workspace_group_member_result_invalid");
      setGroupMemberIds((current) => {
        const next = new Set(current);
        if (included) next.delete(member.membershipId);
        else next.add(member.membershipId);
        return next;
      });
    } catch (error) {
      await handleError(error);
    } finally {
      setBusy(key, false);
    }
  }

  async function deleteGroup() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    const key = `delete:${target.id}`;
    setBusy(key, true);
    try {
      const result = await apiJson(`/api/workspaces/${encodeURIComponent(workspace.id)}/groups/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      if (result.ok !== true) throw new Error("workspace_group_delete_result_invalid");
      const remaining = groups.filter((group) => group.id !== target.id);
      setGroups(remaining);
      setSelectedId(remaining[0]?.id || "");
      setDeleteTarget(null);
      setNotice({ kind: "success", text: `${target.name} 已删除。` });
    } catch (error) {
      await handleError(error);
    } finally {
      setBusy(key, false);
    }
  }

  if (!canManageWorkspace) return <Navigate replace to={`${base}/app`} state={{ workspaceNotice: "你没有权限访问工作区设置。" }} />;
  const selected = groups?.find((group) => group.id === selectedId) || null;
  const deleteBusy = deleteTarget ? busyKeys.has(`delete:${deleteTarget.id}`) : false;

  const content = <>
    <div className={`shWorkspaceSettingsPage ${embedded ? "isEmbedded" : ""}`}>
      <header className="shWorkspaceSettingsHeader"><div><span>{workspace.name} · 工作区设置</span><h1>用户组</h1></div></header>
      <nav className="shWorkspaceSettingsTabs" aria-label="权限设置">
        <Link to={`${base}/settings/members`}>成员与邀请</Link>
        <span className="isActive" aria-current="page">用户组</span>
      </nav>

      {loading ? <div className="shWorkspaceSettingsState" aria-live="polite">正在读取用户组…</div> : null}
      {!loading && pageError ? <div className="shWorkspaceSettingsState isError" role="alert">无法读取用户组：{pageError}<button type="button" onClick={() => void load()}>重新加载</button></div> : null}
      {!loading && !pageError && groups && members ? <div className="shWorkspaceGroupLayout">
        <aside aria-label="用户组列表">
          <header><strong>用户组</strong><button type="button" aria-label="新建用户组" onClick={() => setCreating(true)}><Plus aria-hidden="true" /></button></header>
          {creating ? <form onSubmit={createGroup}><input autoFocus maxLength={160} required aria-label="新用户组名称" value={createName} onChange={(event) => setCreateName(event.target.value)} /><span><button type="button" onClick={() => { setCreating(false); setCreateName(""); }}>取消</button><button type="submit" disabled={busyKeys.has("create") || !createName.trim()}>创建</button></span></form> : null}
          <nav>{groups.map((group) => <button className={group.id === selectedId ? "isActive" : ""} type="button" key={group.id} onClick={() => { setSelectedId(group.id); setRenaming(false); }}><span>{group.kind === "all_members" ? <ShieldCheck aria-hidden="true" /> : <UsersRound aria-hidden="true" />}{group.name}</span><small>{group.kind === "all_members" ? "系统" : "自定义"}</small></button>)}</nav>
        </aside>

        <section className="shWorkspaceGroupDetail">
          {selected ? <>
            <header>
              <div>{renaming ? <form onSubmit={renameGroup}><input autoFocus maxLength={160} required aria-label="用户组名称" value={renameName} onChange={(event) => setRenameName(event.target.value)} /><button type="button" onClick={() => setRenaming(false)}>取消</button><button type="submit" disabled={busyKeys.has(`rename:${selected.id}`) || !renameName.trim()}>保存</button></form> : <><h2>{selected.name}</h2><p>{selected.kind === "all_members" ? "自动包含所有当前有效成员。" : `${groupMemberIds.size} 位成员`}</p></>}</div>
              {selected.kind === "custom" && !renaming ? <span><button type="button" onClick={() => { setRenameName(selected.name); setRenaming(true); }}>重命名</button><button className="isDanger" type="button" aria-label={`删除 ${selected.name}`} onClick={() => setDeleteTarget(selected)}><Trash2 aria-hidden="true" />删除</button></span> : null}
            </header>
            {rosterLoading ? <div className="shWorkspaceSettingsState">正在读取组成员…</div> : <div className="shWorkspaceGroupMembers">
              {members.map((member) => {
                const checked = selected.kind === "all_members" || groupMemberIds.has(member.membershipId);
                const rowBusy = busyKeys.has(`member:${member.membershipId}`);
                return <label key={member.membershipId}><input type="checkbox" checked={checked} disabled={selected.kind === "all_members" || rowBusy} onChange={() => void toggleMember(member)} /><span className="shWorkspaceMemberAvatar" aria-hidden="true">{member.email.slice(0, 1).toUpperCase()}</span><span><strong>{member.email}</strong><small>{roleLabel(member.role)}</small></span></label>;
              })}
            </div>}
          </> : <div className="shWorkspaceSettingsEmpty">当前没有用户组。</div>}
        </section>
      </div> : null}
    </div>
    {notice ? <div className={`shWorkspaceToast ${notice.kind === "error" ? "isError" : ""}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div> : null}
    <ConfirmDialog open={Boolean(deleteTarget)} title="删除用户组" message={deleteTarget ? `确认删除 ${deleteTarget.name}？当前成员关系和所有 Source 授权会一起删除，历史事实不会改写。` : ""} confirmLabel="删除" busy={deleteBusy} onCancel={() => setDeleteTarget(null)} onConfirm={() => void deleteGroup()} />
  </>;
  return embedded ? content : <ShellPage>{content}</ShellPage>;
}
