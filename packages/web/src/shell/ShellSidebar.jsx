import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate, useRouteLoaderData } from "react-router";
import {
  Bot,
  Check,
  ChevronDown,
  FileText,
  Folder,
  Home,
  Library,
  LockKeyhole,
  LogOut,
  MessageSquare,
  PanelLeft,
  Plus,
  Search,
  SlidersHorizontal,
  SquarePen,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { apiJson, apiResponse, clearCsrfToken } from "../api";
import { useModalDialog } from "../components/useModalDialog";
import { AgentMark } from "./AgentMark";
import { SearchOverlay } from "./SearchOverlay";
import { TrashPopover } from "./TrashPopover";

const WORKSPACE_ROLE_LABELS = { owner: "所有者", admin: "管理员", member: "成员" };
const NOTE_TEMPLATES = [
  { name: "任务清单", description: "记录待办、状态与下一步。", preview: ["待处理", "进行中", "已完成"], markdown: "# 任务清单\n\n- [ ] 第一项任务\n" },
  { name: "项目记录", description: "整理目标、进展与关键决定。", preview: ["目标", "进展", "下一步"], markdown: "# 项目记录\n\n## 目标\n\n## 进展\n\n## 决定\n" },
  { name: "研究笔记", description: "汇集问题、来源与阶段结论。", preview: ["问题", "来源", "结论"], markdown: "# 研究笔记\n\n## 问题\n\n## 来源\n\n## 结论\n" },
  { name: "会议记录", description: "保存议题、结论与行动项。", preview: ["议题", "结论", "行动项"], markdown: "# 会议记录\n\n## 议题\n\n## 结论\n\n## 行动项\n" },
  { name: "决策记录", description: "保留背景、理由与后续影响。", preview: ["背景", "决定", "理由"], markdown: "# 决策记录\n\n## 背景\n\n## 决定\n\n## 理由\n\n## 后续\n" },
  { name: "周计划", description: "安排本周重点并持续回顾。", preview: ["本周重点", "待办", "回顾"], markdown: "# 周计划\n\n## 本周重点\n\n## 待办\n\n- [ ] \n\n## 回顾\n" },
  { name: "阅读清单", description: "整理待读内容与阅读收获。", preview: ["待读", "阅读中", "已完成"], markdown: "# 阅读清单\n\n## 待读\n\n- [ ] \n\n## 阅读笔记\n" },
  { name: "内容大纲", description: "从主题、结构到素材组织内容。", preview: ["主题", "结构", "素材"], markdown: "# 内容大纲\n\n## 主题\n\n## 结构\n\n## 素材\n" },
];

function WorkspaceHeader({ workspace, workspaces, user, logoutBusy, logoutError, onLogout, onCollapse, returnTo }) {
  const detailsRef = useRef(null);
  const base = `/w/${encodeURIComponent(workspace.id)}`;

  useEffect(() => {
    const closeOutside = (event) => {
      if (detailsRef.current?.open && !detailsRef.current.contains(event.target)) {
        detailsRef.current.removeAttribute("open");
      }
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") detailsRef.current?.removeAttribute("open");
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return (
    <div className="shWs">
      <details className="shWsMenu" ref={detailsRef}>
        <summary className="shWsButton" role="button" aria-label={`${workspace.name} 工作区菜单`}>
          <span className="shWsAvatar" aria-hidden="true">{workspace.name.slice(0, 1)}</span>
          <span className="shWsName">{workspace.name}</span>
          <ChevronDown aria-hidden="true" />
        </summary>
        <nav className="shWsMenuPopover" aria-label={`${workspace.name} 工作区操作`}>
          <div className="shWsMenuIdentity">
            <span className="shWsAvatar" aria-hidden="true">{workspace.name.slice(0, 1)}</span>
            <span><strong>{workspace.name}</strong><small>{WORKSPACE_ROLE_LABELS[workspace.role]}</small></span>
          </div>
          <div className="shWsMenuDivider" />
          <div className="shWsMenuAccount">{user.email}</div>
          <Link to={`${base}/settings/preferences`} state={{ returnTo }}><SlidersHorizontal aria-hidden="true" />设置</Link>
          {workspaces.length > 1 ? <div className="shWsMenuWorkspaces" role="group" aria-label="切换工作区">
            {workspaces.map((item) => item.id === workspace.id
              ? <span className="shWsMenuWorkspace isCurrent" aria-current="page" key={item.id}>
                  <span className="shWsAvatar" aria-hidden="true">{item.name.slice(0, 1)}</span>
                  <span>{item.name}</span>
                  <Check aria-hidden="true" />
                </span>
              : <Link className="shWsMenuWorkspace" to={`/w/${encodeURIComponent(item.id)}/app`} key={item.id}>
                  <span className="shWsAvatar" aria-hidden="true">{item.name.slice(0, 1)}</span>
                  <span>{item.name}</span>
                </Link>)}
          </div> : null}
          <div className="shWsMenuDivider" />
          <button type="button" disabled={logoutBusy} onClick={onLogout}><LogOut aria-hidden="true" />{logoutBusy ? "正在退出…" : "退出登录"}</button>
          {logoutError ? <p className="shWsMenuError" role="alert">{logoutError}</p> : null}
        </nav>
      </details>
      {onCollapse ? <button className="shSidebarCollapse" type="button" aria-label="隐藏左侧栏" title="隐藏左侧栏" onClick={onCollapse}><PanelLeft aria-hidden="true" /></button> : null}
    </div>
  );
}

function PrivateCreateDialog({ onClose, onCreateNote, onUpload }) {
  const [query, setQuery] = useState("");
  const dialogRef = useModalDialog({ onClose });
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleTemplates = NOTE_TEMPLATES.filter((template) => !normalizedQuery || `${template.name}${template.description}`.toLocaleLowerCase().includes(normalizedQuery));

  return createPortal(<div className="shPrivateCreateBackdrop" role="presentation" onMouseDown={onClose}>
    <section className="shPrivateCreateDialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label="新增私人内容" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
      <header className="shPrivateCreateHeader">
        <div><button className="quietCloseButton" type="button" aria-label="关闭新增" onClick={onClose}><X aria-hidden="true" /></button><span>添加到</span><strong><LockKeyhole aria-hidden="true" />私人</strong></div>
        <label><Search aria-hidden="true" /><input autoFocus aria-label="搜索新增模板" placeholder="搜索" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      </header>
      <div className="shPrivateCreateScroll">
        <div className="shPrivateCreateContent">
          <div className="shPrivateCreateQuick">
            <button type="button" onClick={() => onCreateNote({ name: "Untitled", markdown: "" })}><FileText aria-hidden="true" /><strong>空白笔记</strong></button>
            <button type="button" onClick={onUpload}><Upload aria-hidden="true" /><strong>上传资料</strong></button>
          </div>
          <h2><FileText aria-hidden="true" />模板</h2>
          <div className="shPrivateTemplateGrid">
            {visibleTemplates.map((template) => <button className="shPrivateTemplateCard" type="button" key={template.name} onClick={() => onCreateNote(template)}>
              <span><strong>{template.name}</strong><small>{template.description}</small></span>
              <div className="shPrivateTemplatePreview" aria-hidden="true"><strong>{template.name}</strong>{template.preview.map((label) => <i key={label}><span /><em>{label}</em></i>)}</div>
            </button>)}
            {!visibleTemplates.length ? <p>没有匹配的模板</p> : null}
          </div>
        </div>
      </div>
    </section>
  </div>, document.body);
}

function ProjectCreateDialog({ onClose, onCreate }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useModalDialog({ onClose });

  async function submit(event) {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!normalizedName || busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreate(normalizedName);
      onClose();
    } catch {
      setError("创建项目失败，请重试。");
      setBusy(false);
    }
  }

  return createPortal(<div className="shPrivateCreateBackdrop" role="presentation" onMouseDown={onClose}>
    <form className="shProjectCreateDialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="shProjectCreateTitle" tabIndex={-1} onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
      <header><button className="quietCloseButton" type="button" aria-label="关闭创建项目" onClick={onClose}><X aria-hidden="true" /></button><h2 id="shProjectCreateTitle">创建项目</h2></header>
      <label>
        <span>项目名称</span>
        <input className="shProjectNameInput" autoFocus maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <footer><button type="button" onClick={onClose}>取消</button><button className="isPrimary" type="submit" disabled={!name.trim() || busy}>{busy ? "正在创建…" : "创建项目"}</button></footer>
    </form>
  </div>, document.body);
}

function HomeTab({ base, notes, notesError, onCreateNote, onOpenCreate, trashOpen, onToggleTrash, trashTriggerRef }) {
  return (
    <div className="shScroll">
      <section className="shSection shCollapsibleSection">
        <details className="shDisclosure" open>
          <summary className="shSectionHeader shDisclosureSummary"><span>私人</span><ChevronDown aria-hidden="true" /></summary>
          <div className="shDisclosureBody">
            {(notes || []).map((note) => <Link className="shRow" to={`${base}/library/${encodeURIComponent(note.id)}`} key={note.id}><FileText aria-hidden="true" /><span>{note.displayName}</span></Link>)}
            {notesError ? <p className="shEmptyHint">无法读取私人文档</p> : null}
            {notes && notes.length <= 2 ? <button className="shRow" type="button" onClick={onOpenCreate}><Plus aria-hidden="true" /><span>新增</span></button> : null}
          </div>
        </details>
        <button className="shSectionAction" type="button" aria-label="在私人中新增" title="新增页面" onClick={onCreateNote}><Plus aria-hidden="true" /></button>
      </section>

      <section className="shSection shPrimaryNav">
        <Link className="shRow" to={`${base}/agents/new`}><Bot aria-hidden="true" /><span>添加代理</span></Link>
        <Link className="shRow" to={`${base}/library`}><Library aria-hidden="true" /><span>库</span></Link>
        <button className={`shRow ${trashOpen ? "isActive" : ""}`} ref={trashTriggerRef} type="button" data-trash-trigger aria-expanded={trashOpen} onClick={onToggleTrash}><Trash2 aria-hidden="true" /><span>垃圾桶</span></button>
      </section>
    </div>
  );
}

function ConversationTab({ agents, base, sessionProps, onStartNewChat }) {
  const navigate = useNavigate();
  const startNewChat = (projectId = "") => {
    if (onStartNewChat) onStartNewChat(projectId);
    else navigate(`${base}/app`);
  };
  return (
    <div className="shScroll">
      <section className="shSection">
        <header className="shSectionHeader">
          <span>代理</span>
          <Link className="shSectionAction" to={`${base}/agents/new`} aria-label="添加代理"><Plus aria-hidden="true" /></Link>
        </header>
        <div className="shAgentStrip">
          {agents.map((agent) => <Link to={`${base}/agents/${encodeURIComponent(agent.id)}?new=1`} key={agent.id}><AgentMark className="shAgentGlyph" agent={agent} /><span>{agent.name}</span></Link>)}
          <Link className="shNewAgentTile" to={`${base}/agents/new`}><Plus aria-hidden="true" /><span>新代理</span></Link>
        </div>
      </section>

      <div className="shDivider" />

      {sessionProps ? <>
        <section className="shSection shCollapsibleSection shSessionSection">
          <details className="shDisclosure" open>
            <summary className="shSectionHeader shDisclosureSummary"><span>置顶</span><ChevronDown aria-hidden="true" /></summary>
            <nav className="workspaceSessionList" aria-label="置顶会话">
              {sessionProps.groupedSessions.pinned.map((session) => sessionProps.renderSessionRow(session, { icon: true }))}
            </nav>
          </details>
        </section>

        <section className="shSection shCollapsibleSection shSessionSection">
          <details className="shDisclosure" open>
            <summary className="shSectionHeader shDisclosureSummary"><span>项目</span><ChevronDown aria-hidden="true" /></summary>
            <div className="shProjectTree">
              {sessionProps.projects.map((project) => <section className="shProject" key={project.id}>
                <details className="shProjectDisclosure" open>
                  <summary className="shProjectSummary"><ChevronDown aria-hidden="true" /><Folder aria-hidden="true" /><span>{project.name}</span></summary>
                  <nav className="workspaceSessionList isProject" aria-label={`${project.name} 会话`}>
                    {sessionProps.groupedSessions.projectSessions[project.id].map((session) => sessionProps.renderSessionRow(session, { nested: true }))}
                  </nav>
                </details>
                <button className="shProjectAction" type="button" aria-label={`在 ${project.name} 中新建会话`} onClick={() => startNewChat(project.id)}><Plus aria-hidden="true" /></button>
              </section>)}
            </div>
          </details>
          <button className="shSectionAction" type="button" aria-label="创建项目" onClick={sessionProps.onOpenProjectCreate}><Plus aria-hidden="true" /></button>
        </section>

        <section className="shSection shCollapsibleSection shSessionSection">
          <details className="shDisclosure" open>
            <summary className="shSectionHeader shDisclosureSummary"><span>最近</span><ChevronDown aria-hidden="true" /></summary>
            <nav className="workspaceSessionList" aria-label="最近会话">
              {sessionProps.groupedSessions.recent.map((session) => sessionProps.renderSessionRow(session))}
            </nav>
            {!sessionProps.sessions.length ? <p className="shEmptyHint">尚无会话</p> : null}
          </details>
          <button className="shSectionAction" type="button" aria-label="新建一般会话" onClick={() => startNewChat()}><Plus aria-hidden="true" /></button>
        </section>
      </> : (
        <section className="shSection"><button className="shRow" type="button" onClick={() => navigate(`${base}/app`)}><MessageSquare aria-hidden="true" /><span>打开会话列表</span></button></section>
      )}
    </div>
  );
}

export function ShellSidebar({ workspace, agents, activeAgent, sessionProps, onStartNewChat, onCollapse, initialTab = "home" }) {
  const [tab, setTab] = useState(initialTab);
  const [searchOpen, setSearchOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [privateCreateOpen, setPrivateCreateOpen] = useState(false);
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  const [privateNotes, setPrivateNotes] = useState(null);
  const [privateNotesError, setPrivateNotesError] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const createMenuRef = useRef(null);
  const trashTriggerRef = useRef(null);
  const { user } = useRouteLoaderData("authenticated");
  const { workspaces = [workspace] } = useRouteLoaderData("workspace");
  const location = useLocation();
  const navigate = useNavigate();
  const lastInitialTab = useRef(initialTab);
  const base = `/w/${encodeURIComponent(workspace.id)}`;

  useEffect(() => {
    if (lastInitialTab.current !== initialTab) {
      lastInitialTab.current = initialTab;
      setTab(initialTab);
    }
  }, [initialTab]);

  useEffect(() => {
    let active = true;
    setPrivateNotesError(false);
    apiJson("/api/library")
      .then((result) => {
        if (!active) return;
        if (!Array.isArray(result.objects)) throw new Error("library_objects_invalid");
        setPrivateNotes(result.objects.filter((item) => item.objectKind === "note"));
      })
      .catch(() => active && setPrivateNotesError(true));
    return () => { active = false; };
  }, [location.pathname]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!createMenuOpen) return undefined;
    const closeOutside = (event) => {
      if (!createMenuRef.current?.contains(event.target)) setCreateMenuOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setCreateMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [createMenuOpen]);

  function showHome() {
    setCreateMenuOpen(false);
    setTrashOpen(false);
    setTab("home");
    if (!sessionProps && location.pathname !== `${base}/app`) navigate(`${base}/app`, { state: { sidebarTab: "home" } });
  }

  function showConversations() {
    setCreateMenuOpen(false);
    setTrashOpen(false);
    setTab("chat");
    if (sessionProps) return;
    if (activeAgent) navigate(`${base}/agents/${encodeURIComponent(activeAgent.id)}`);
    else if (agents.length === 1) navigate(`${base}/agents/${encodeURIComponent(agents[0].id)}`);
    else navigate(`${base}/app`);
  }

  const defaultNewChat = () => {
    navigate(`${base}/app`);
  };

  function createNote(template) {
    setPrivateCreateOpen(false);
    setCreateMenuOpen(false);
    navigate(`${base}/library/new`, { state: { noteDraft: template } });
  }

  function openUpload() {
    setPrivateCreateOpen(false);
    navigate(`${base}/library?upload=1`);
  }

  async function logout() {
    if (logoutBusy) return;
    setLogoutBusy(true);
    setLogoutError("");
    try {
      await apiResponse("/api/logout", { method: "POST" });
      clearCsrfToken();
      navigate("/login", { replace: true });
    } catch {
      setLogoutError("退出失败，请重试。");
      setLogoutBusy(false);
    }
  }

  return (
    <aside className="workspaceSidebar shSidebar" aria-label="会话导航">
      <WorkspaceHeader workspace={workspace} workspaces={workspaces} user={user} logoutBusy={logoutBusy} logoutError={logoutError} onLogout={logout} onCollapse={onCollapse ? () => { setTrashOpen(false); onCollapse(); } : undefined} returnTo={`${location.pathname}${location.search}`} />
      <div className="shTabs" role="tablist" aria-label="主视图">
        <button className={`shTab ${tab === "home" ? "isActive" : ""}`} type="button" role="tab" aria-label="主页" title="主页" aria-selected={tab === "home"} onClick={showHome}>
          <Home aria-hidden="true" />
        </button>
        <button className={`shTab ${tab === "chat" ? "isActive" : ""}`} type="button" role="tab" aria-label="对话" title="对话" aria-selected={tab === "chat"} onClick={showConversations}>
          <MessageSquare aria-hidden="true" />
        </button>
        <button className="shSearchButton" type="button" aria-label="搜索会话和笔记" title="搜索 · Ctrl+K" onClick={() => setSearchOpen(true)}>
          <Search aria-hidden="true" />
        </button>
      </div>

      {tab === "home" ? <HomeTab base={base} notes={privateNotes} notesError={privateNotesError} onCreateNote={() => { setCreateMenuOpen(false); setTrashOpen(false); createNote({ name: "Untitled", markdown: "" }); }} onOpenCreate={() => { setCreateMenuOpen(false); setTrashOpen(false); setPrivateCreateOpen(true); }} trashOpen={trashOpen} onToggleTrash={() => { setCreateMenuOpen(false); setTrashOpen((value) => !value); }} trashTriggerRef={trashTriggerRef} /> : <ConversationTab agents={agents} base={base} sessionProps={sessionProps ? { ...sessionProps, onOpenProjectCreate: () => setProjectCreateOpen(true) } : null} onStartNewChat={onStartNewChat} />}

      <footer className="shFooterNav" ref={createMenuRef}>
        <button className="shNewChat" type="button" onClick={() => (onStartNewChat || defaultNewChat)()}>{activeAgent ? <AgentMark className="shFooterMark" agent={activeAgent} /> : <SquarePen aria-hidden="true" />}新对话 <kbd>Ctrl+O</kbd></button>
        <button className="shComposeChat" type="button" aria-label="打开新增菜单" aria-expanded={createMenuOpen} onClick={() => setCreateMenuOpen((open) => !open)}>{createMenuOpen ? <X aria-hidden="true" /> : <SquarePen aria-hidden="true" />}</button>
        {createMenuOpen ? <div className="shCreateMenu" role="menu">
          <button type="button" role="menuitem" onClick={() => createNote({ name: "Untitled", markdown: "" })}><FileText aria-hidden="true" />笔记</button>
          <button type="button" role="menuitem" onClick={() => { setCreateMenuOpen(false); (onStartNewChat || defaultNewChat)(); }}><MessageSquare aria-hidden="true" />对话</button>
        </div> : null}
      </footer>
      {searchOpen ? <SearchOverlay sessions={sessionProps?.sessions || []} workspace={workspace} agents={agents} agentId={sessionProps?.agentId || activeAgent?.id || ""} onClose={() => setSearchOpen(false)} /> : null}
      {privateCreateOpen ? <PrivateCreateDialog onClose={() => setPrivateCreateOpen(false)} onCreateNote={createNote} onUpload={openUpload} /> : null}
      {projectCreateOpen ? <ProjectCreateDialog onClose={() => setProjectCreateOpen(false)} onCreate={sessionProps.onCreateProject} /> : null}
      <TrashPopover open={trashOpen} workspace={workspace} anchorRef={trashTriggerRef} onClose={() => setTrashOpen(false)} />
    </aside>
  );
}
