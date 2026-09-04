import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useRouteLoaderData, useSearchParams } from "react-router";
import {
  Bot, BookOpen, ChevronDown, ChevronRight, Download, FileText, Folder, FolderInput,
  Image as ImageIcon, Layers, LoaderCircle, MessageSquarePlus, Minus,
  Search, Trash2, Upload, X,
} from "lucide-react";
import { apiJson as api, apiUrl, jsonOptions } from "../api";
import { useModalDialog } from "../components/useModalDialog";
import { AgentMark } from "../shell/AgentMark";
import { ShellPage } from "../shell/ShellPage";
import { MAX_UPLOAD_BATCH_FILES } from "../upload";

function isImage(item) {
  return item.objectKind === "image" || item.contentType.startsWith("image/");
}

function isFolder(item) {
  return item.objectKind === "folder";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(date);
}

function statusLabel(item) {
  if (item.status === "ready") return "";
  if (item.status === "processing") return "处理中";
  if (item.status === "failed") return "处理失败";
  throw new Error(`unsupported library status: ${item.status}`);
}

const LIBRARY_VIEWS = new Set(["materials", "knowledge", "agents", "skills"]);
const LIBRARY_TABS = [
  ["materials", "资料", Folder],
  ["knowledge", "知识库", BookOpen],
  ["agents", "代理", Bot],
  ["skills", "Skills", Layers],
];

function SkillMarkdown({ content }) {
  const source = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const blocks = source.trim().split(/\r?\n\r?\n/);
  const inline = (text) => text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) => part.startsWith("`")
    ? <code key={index}>{part.slice(1, -1)}</code>
    : part.startsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : part);
  return blocks.map((block, index) => {
    const heading = block.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const Heading = `h${heading[1].length}`;
      return <Heading key={index}>{inline(heading[2])}</Heading>;
    }
    const lines = block.split(/\r?\n/);
    if (lines.every((line) => /^[-*]\s+/.test(line))) return <ul key={index}>{lines.map((line, lineIndex) => <li key={lineIndex}>{inline(line.replace(/^[-*]\s+/, ""))}</li>)}</ul>;
    if (lines.every((line) => /^\d+\.\s+/.test(line))) return <ol key={index}>{lines.map((line, lineIndex) => <li key={lineIndex}>{inline(line.replace(/^\d+\.\s+/, ""))}</li>)}</ol>;
    if (block.startsWith("```") && block.endsWith("```")) return <pre key={index}><code>{block.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "")}</code></pre>;
    return <p key={index}>{inline(block)}</p>;
  });
}

function LibraryPageContent() {
  const navigate = useNavigate();
  const { workspace, agents } = useRouteLoaderData("workspace");
  const base = `/w/${encodeURIComponent(workspace.id)}`;
  const [searchParams] = useSearchParams();
  const fileInputRef = useRef(null);
  const libraryView = searchParams.get("view") || "materials";
  const folderId = searchParams.get("folder") || "";
  const [objects, setObjects] = useState([]);
  const [skills, setSkills] = useState(null);
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [skillDetail, setSkillDetail] = useState(null);
  const [skillDetailLoading, setSkillDetailLoading] = useState(false);
  const [skillDetailError, setSkillDetailError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [folderPath, setFolderPath] = useState([]);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadQueue, setUploadQueue] = useState([]);
  const [uploadDialogError, setUploadDialogError] = useState("");
  const [uploadDragActive, setUploadDragActive] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [dialog, setDialog] = useState(() => searchParams.get("upload") === "1" ? "upload" : "");
  const [dialogTitle, setDialogTitle] = useState("");
  const [moveFolderId, setMoveFolderId] = useState("");
  const [moveObjects, setMoveObjects] = useState([]);
  const [moveLoading, setMoveLoading] = useState(false);
  const [creatingMoveFolder, setCreatingMoveFolder] = useState(false);
  const [moveFolderName, setMoveFolderName] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useModalDialog({ open: Boolean(dialog), busy: working || uploading, onClose: closeDialog });

  if (!LIBRARY_VIEWS.has(libraryView)) throw new Error(`unsupported library view: ${libraryView}`);

  const selectedItems = objects.filter((item) => selectedIds.includes(item.id));

  function libraryUrl(nextFolderId = "") {
    return nextFolderId ? `${base}/library?folder=${encodeURIComponent(nextFolderId)}` : `${base}/library`;
  }

  async function loadFolderPath(currentFolderId) {
    if (!currentFolderId) return [];
    const path = [];
    let nextId = currentFolderId;
    while (nextId) {
      const result = await api(`/api/library/${nextId}`);
      path.unshift(result.object);
      nextId = result.object.parentFolderId || "";
    }
    return path;
  }

  async function loadLibrary() {
    setLoading(true);
    setError("");
    try {
      const suffix = folderId ? `?parentFolderId=${encodeURIComponent(folderId)}` : "";
      const [library, path] = await Promise.all([
        api(`/api/library${suffix}`), loadFolderPath(folderId),
      ]);
      setObjects(library.objects);
      setFolderPath(path);
      setSelectedIds([]);
    } catch (requestError) {
      if (requestError.status === 404 && folderId) {
        navigate(`${base}/library`, { replace: true });
        return;
      }
      setError(`无法读取资料库：${requestError.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadLibrary();
  }, [folderId]);

  useEffect(() => {
    setQuery("");
    setSelectedIds([]);
    setCatalogError("");
    setSelectedSkillId("");
    setSkillDetail(null);
    setSkillDetailError("");
  }, [libraryView]);

  useEffect(() => {
    if (libraryView !== "skills") return undefined;
    let active = true;
    setSkills(null);
    api(`/api/workspaces/${workspace.id}/skills`)
      .then((result) => {
        if (active) setSkills(result.skills);
      })
      .catch((requestError) => {
        if (active) setCatalogError(`无法读取 Skills：${requestError.message}`);
      });
    return () => { active = false; };
  }, [libraryView, workspace.id]);

  useEffect(() => {
    if (!selectedSkillId) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setSelectedSkillId("");
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedSkillId]);

  async function openSkill(skillId) {
    setSelectedSkillId(skillId);
    setSkillDetail(null);
    setSkillDetailLoading(true);
    setSkillDetailError("");
    try {
      const result = await api(`/api/workspaces/${workspace.id}/skills/${encodeURIComponent(skillId)}`);
      setSkillDetail(result);
    } catch (requestError) {
      setSkillDetailError(`无法打开 Skill：${requestError.message}`);
    } finally {
      setSkillDetailLoading(false);
    }
  }

  function uploadFileKey(file) {
    return [file.name, file.size, file.lastModified, file.type].join("\u0000");
  }

  function addUploadFiles(incomingFiles) {
    const files = Array.from(incomingFiles || []);
    if (!files.length || uploading) return;
    const existingKeys = new Set(uploadQueue.map(uploadFileKey));
    const nextKeys = new Set();
    const duplicate = files.find((file) => {
      const key = uploadFileKey(file);
      if (existingKeys.has(key) || nextKeys.has(key)) return true;
      nextKeys.add(key);
      return false;
    });
    if (duplicate) {
      setUploadDialogError(`${duplicate.name} 已在上传队列中`);
      return;
    }
    if (uploadQueue.length + files.length > MAX_UPLOAD_BATCH_FILES) {
      setUploadDialogError(`一次最多上传 ${MAX_UPLOAD_BATCH_FILES} 个文件`);
      return;
    }
    setUploadDialogError("");
    setUploadQueue((current) => [...current, ...files]);
  }

  function selectUploadFile(event) {
    addUploadFiles(event.target.files);
    event.target.value = "";
  }

  function openUploadDialog() {
    setNewMenuOpen(false);
    setUploadQueue([]);
    setUploadDialogError("");
    setUploadDragActive(false);
    setDialog("upload");
  }

  function closeUploadDialog() {
    if (uploading) return;
    setUploadQueue([]);
    setUploadDialogError("");
    setUploadDragActive(false);
    setDialog("");
  }

  function closeDialog() {
    if (dialog === "upload") closeUploadDialog();
    else if (!working) setDialog("");
  }

  function removeUploadFile(file) {
    if (uploading) return;
    const targetKey = uploadFileKey(file);
    setUploadQueue((current) => current.filter((item) => uploadFileKey(item) !== targetKey));
    setUploadDialogError("");
  }

  async function uploadQueuedFiles() {
    const files = [...uploadQueue];
    if (!files.length || uploading) return;
    setUploading(true);
    setUploadDialogError("");
    try {
      const body = new FormData();
      files.forEach((file) => body.append("files", file));
      if (folderId) body.append("parentFolderId", folderId);
      const result = await api("/api/library", { method: "POST", body });
      if (
        !Array.isArray(result.objects)
        || result.objects.length !== files.length
        || result.objects.some((item, index) => !item?.id || item.displayName !== files[index].name)
        || new Set(result.objects.map((item) => item.id)).size !== files.length
      ) {
        throw new Error("library_upload_response_invalid");
      }
      setUploadQueue([]);
      setDialog("");
      await loadLibrary();
    } catch (requestError) {
      setUploadDialogError(`上传失败：${requestError.message}`);
    } finally {
      setUploading(false);
    }
  }

  async function createFolder() {
    if (!dialogTitle.trim() || working) return;
    setWorking(true);
    try {
      await api("/api/library/folders", jsonOptions("POST", { displayName: dialogTitle, parentFolderId: folderId || null }));
      setDialog("");
      await loadLibrary();
    } catch (requestError) {
      setError(`新建文件夹失败：${requestError.message}`);
    } finally {
      setWorking(false);
    }
  }

  function createNote() {
    setNewMenuOpen(false);
    navigate(`${base}/library/new${folderId ? `?folder=${encodeURIComponent(folderId)}` : ""}`, {
      state: { noteDraft: { name: "Untitled", markdown: "" } },
    });
  }

  async function loadMoveDirectory(nextFolderId = "") {
    setMoveLoading(true);
    try {
      const suffix = nextFolderId ? `?parentFolderId=${encodeURIComponent(nextFolderId)}` : "";
      const result = await api(`/api/library${suffix}`);
      setMoveFolderId(nextFolderId);
      setMoveObjects(result.objects);
    } catch (requestError) {
      setError(`无法读取目标目录：${requestError.message}`);
    } finally {
      setMoveLoading(false);
    }
  }

  async function openMoveDialog() {
    if (!selectedItems.length || working) return;
    setError("");
    setCreatingMoveFolder(false);
    setMoveFolderName("");
    setDialog("move");
    await loadMoveDirectory("");
  }

  async function moveSelected() {
    if (!selectedItems.length || working) return;
    setWorking(true);
    try {
      await Promise.all(selectedItems.map((item) => api(`/api/library/${item.id}`, jsonOptions("PATCH", { parentFolderId: moveFolderId || null }))));
      setDialog("");
      await loadLibrary();
    } catch (requestError) {
      setError(`移动失败：${requestError.message}`);
    } finally {
      setWorking(false);
    }
  }

  async function createMoveFolder() {
    if (!moveFolderName.trim() || working) return;
    setWorking(true);
    try {
      await api("/api/library/folders", jsonOptions("POST", { displayName: moveFolderName, parentFolderId: moveFolderId || null }));
      setMoveFolderName("");
      setCreatingMoveFolder(false);
      await loadMoveDirectory(moveFolderId);
    } catch (requestError) {
      setError(`新建文件夹失败：${requestError.message}`);
    } finally {
      setWorking(false);
    }
  }

  async function deleteSelected() {
    if (!selectedItems.length || working) return;
    setWorking(true);
    try {
      const results = await Promise.allSettled(selectedItems.map((item) => api(`/api/library/${item.id}`, { method: "DELETE" })));
      const failures = results.filter((result) => result.status === "rejected");
      await loadLibrary();
      if (failures.length) {
        const nonEmpty = failures.some((result) => result.reason?.message === "library_folder_not_empty");
        setError(nonEmpty
          ? `${results.length - failures.length} 项已移到垃圾桶；${failures.length} 个非空文件夹未处理。`
          : `${results.length - failures.length} 项已移到垃圾桶；${failures.length} 项失败，请重试。`);
      }
    } finally {
      setWorking(false);
    }
  }

  async function createChat(agentId) {
    setDialog("");
    if (!selectedItems.length || selectedItems.some(isFolder) || !workspace || working) return;
    setWorking(true);
    try {
      const created = await api(`/api/workspaces/${workspace.id}/sessions`, jsonOptions("POST", {
        agentId,
      }));
      await Promise.all(selectedItems.map((item) => api(`/api/sessions/${created.session.id}/assets`, jsonOptions("POST", {
        assetKind: "userLibraryObject", assetId: item.id,
      }))));
      navigate(`${base}/agents/${encodeURIComponent(created.session.agentId)}?sessionId=${encodeURIComponent(created.session.id)}`);
    } catch (requestError) {
      setError(`无法开始聊天：${requestError.message}`);
    } finally {
      setWorking(false);
    }
  }

  function startChat() {
    if (agents.length === 1) void createChat(agents[0].id);
    else if (agents.length > 1) setDialog("agent");
    else navigate(`${base}/app`);
  }

  const visibleObjects = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return objects.filter((item) => {
      if (filter === "images" && !isImage(item)) return false;
      if (filter === "files" && (isImage(item) || isFolder(item))) return false;
      return !normalizedQuery || item.displayName.toLocaleLowerCase().includes(normalizedQuery);
    });
  }, [filter, objects, query]);
  const normalizedCatalogQuery = query.trim().toLocaleLowerCase();
  const visibleAgents = agents.filter((agent) => !normalizedCatalogQuery || `${agent.name} ${agent.description}`.toLocaleLowerCase().includes(normalizedCatalogQuery));
  const visibleSkills = (skills || []).filter((skill) => !normalizedCatalogQuery || `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(normalizedCatalogQuery));
  const visibleObjectIds = visibleObjects.map((item) => item.id);
  const allVisibleSelected = visibleObjectIds.length > 0 && visibleObjectIds.every((itemId) => selectedIds.includes(itemId));
  const selectionContainsFolder = selectedItems.some(isFolder);

  function toggleSelection(itemId) {
    setSelectedIds((current) => current.includes(itemId) ? current.filter((currentId) => currentId !== itemId) : [...current, itemId]);
  }

  function toggleAllVisible() {
    setSelectedIds((current) => allVisibleSelected
      ? current.filter((itemId) => !visibleObjectIds.includes(itemId))
      : [...new Set([...current, ...visibleObjectIds])]);
  }

  function downloadSelected() {
    selectedItems.forEach((item) => {
      const link = document.createElement("a");
      link.href = apiUrl(`/api/library/${item.id}/download`);
      link.download = item.displayName;
      document.body.append(link);
      link.click();
      link.remove();
    });
  }

  return (
    <ShellPage>
      <div className={`libraryWorkspace ${selectedSkillId ? "hasSkillPeek" : ""}`}>
        <section className="libraryMain shEmbeddedLibrary" aria-labelledby="library-title">
        <header className="libraryHeader">
          <h1 id="library-title">库</h1>
          {libraryView === "materials" ? <div className="libraryHeaderActions">
            <div className="libraryNewMenu">
              <button className="libraryNewButton" type="button" aria-expanded={newMenuOpen} aria-haspopup="menu" onClick={() => setNewMenuOpen((open) => !open)}>新建<ChevronDown aria-hidden="true" /></button>
              {newMenuOpen && <div className="libraryNewMenuPanel" role="menu">
                <button type="button" role="menuitem" disabled={uploading} onClick={openUploadDialog}><Upload aria-hidden="true" />上传文件</button>
                <button type="button" role="menuitem" onClick={() => { setNewMenuOpen(false); setDialogTitle(""); setDialog("folder"); }}><Folder aria-hidden="true" />文件夹</button>
                <button type="button" role="menuitem" onClick={createNote}><FileText aria-hidden="true" />笔记</button>
              </div>}
            </div>
          </div> : null}
        </header>

        <div className="libraryContent">
          <nav className="libraryCatalogTabs" role="tablist" aria-label="库类型">
            {LIBRARY_TABS.map(([value, label, Icon]) => <Link
              className={libraryView === value ? "isActive" : ""}
              role="tab"
              aria-selected={libraryView === value}
              to={value === "materials" ? `${base}/library` : `${base}/library?view=${value}`}
              key={value}
            ><Icon aria-hidden="true" />{label}</Link>)}
          </nav>

          <div className="libraryCatalogTools">
            {libraryView === "materials" && selectedItems.length ? <div className="librarySelectionBar" aria-label="已选文件操作">
              <span>已选 {selectedItems.length} 个</span>
              <button className="primary" type="button" disabled={selectionContainsFolder || working} onClick={startChat}><MessageSquarePlus aria-hidden="true" />开始聊天</button>
              <button type="button" disabled={selectionContainsFolder || working} onClick={downloadSelected}><Download aria-hidden="true" />下载</button>
              <button type="button" disabled={working} onClick={openMoveDialog}><FolderInput aria-hidden="true" />移动</button>
              <button className="danger" type="button" disabled={working} onClick={() => void deleteSelected()}><Trash2 aria-hidden="true" />移到垃圾桶</button>
            </div> : libraryView === "materials" ? <div className="libraryFilters" role="tablist" aria-label="资料类型">
              {[["all", "全部"], ["images", "图片"], ["files", "文件"]].map(([value, label]) => <button className={filter === value ? "active" : ""} type="button" key={value} role="tab" aria-selected={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
            </div> : <span className="libraryCatalogAll">全部</span>}
            <label className="librarySearch"><Search aria-hidden="true" /><span className="srOnly">搜索当前库</span><input aria-label="搜索当前库" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索" /></label>
          </div>

          {libraryView === "materials" ? <>
            {folderPath.length > 0 && <nav className="libraryBreadcrumb" aria-label="当前文件夹"><button type="button" onClick={() => navigate(`${base}/library`)}>资料库</button>{folderPath.map((folder) => <span key={folder.id}><ChevronRight aria-hidden="true" /><button type="button" onClick={() => navigate(libraryUrl(folder.id))}>{folder.displayName}</button></span>)}</nav>}
            {error && <div className="errorBanner libraryError" role="alert">{error}<button type="button" onClick={loadLibrary}>重试</button></div>}
            <div className={`libraryList ${selectedItems.length ? "hasSelection" : ""}`} role="table" aria-label="个人资料库文件">
              <div className="libraryListHeader" role="row">
                <button className="librarySelect librarySelectAll" type="button" role="checkbox" aria-checked={allVisibleSelected} aria-label={allVisibleSelected ? "取消全选" : "全选当前列表"} onClick={toggleAllVisible}>{allVisibleSelected ? <Minus aria-hidden="true" /> : null}</button>
                <span role="columnheader">名称</span><span role="columnheader">修改时间</span><span role="columnheader">大小</span>
              </div>
              {loading ? <div className="libraryEmptyState" role="status" aria-live="polite"><LoaderCircle className="statusIcon" aria-hidden="true" />正在加载资料库</div> : visibleObjects.length === 0 ? <div className="libraryEmptyState">{objects.length === 0 ? "还没有资料。会话上传的附件会自动保存在这里。" : "没有符合筛选条件的资料。"}</div> : visibleObjects.map((item) => {
                const ItemIcon = isFolder(item) ? Folder : isImage(item) ? ImageIcon : FileText;
                const itemStatus = statusLabel(item);
                return <div className={`libraryRow ${selectedIds.includes(item.id) ? "selected" : ""}`} role="row" key={item.id}>
                  <label className="librarySelect"><input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => toggleSelection(item.id)} /><span className="srOnly">选择 {item.displayName}</span></label>
                  <button className="libraryName" type="button" role="cell" onClick={() => navigate(isFolder(item) ? libraryUrl(item.id) : `${base}/library/${item.id}?folder=${encodeURIComponent(folderId)}`)}>
                    {isImage(item) && item.status === "ready" ? <img className="libraryThumbnail" src={apiUrl(`/api/library/${item.id}/preview`)} alt="" loading="lazy" /> : <ItemIcon aria-hidden="true" />}<span>{item.displayName}</span>{itemStatus && <small>{itemStatus}</small>}
                  </button>
                  <span role="cell">{formatDate(item.updatedAt)}</span><span role="cell">{isFolder(item) ? "—" : formatBytes(item.sizeBytes)}</span>
                </div>;
              })}
            </div>
          </> : libraryView === "knowledge" ? <div className="libraryCatalogEmpty"><BookOpen aria-hidden="true" /><strong>还没有知识库</strong><span>真实 Source 接入后会显示在这里。</span></div>
            : libraryView === "agents" ? <div className="libraryAgentStrip" aria-label="代理">
              {visibleAgents.map((agent) => <Link className="libraryAgentCard" to={`${base}/agents/${encodeURIComponent(agent.id)}`} key={agent.id}><AgentMark agent={agent} /><strong>{agent.name}</strong><small>{agent.description || "私人代理"}</small></Link>)}
              <Link className="libraryAgentCard isAdd" to={`${base}/agents/new`}><span aria-hidden="true">＋</span><strong>新代理</strong></Link>
              {!visibleAgents.length && normalizedCatalogQuery ? <p className="libraryCatalogNoMatch">没有匹配的代理</p> : null}
            </div>
              : <>
                  {catalogError ? <div className="errorBanner libraryError" role="alert">{catalogError}</div> : null}
                  {skills === null && !catalogError ? <div className="libraryCatalogEmpty" role="status" aria-live="polite"><LoaderCircle className="statusIcon" aria-hidden="true" />正在读取 Skills</div> : null}
                  {skills?.length === 0 && !catalogError ? <div className="libraryCatalogEmpty"><Layers aria-hidden="true" /><strong>当前工作区没有可用 Skills</strong><span>启用包含 Skill 的插件后会显示在这里。</span></div> : null}
                  {skills?.length ? <div className="librarySkillTable" role="table" aria-label="Skills">
                    <div className="librarySkillRow isHead" role="row"><span>名称</span><span>描述</span><span>来源</span><span>调用</span></div>
                    {visibleSkills.map((skill) => <button className={`librarySkillRow ${selectedSkillId === skill.skillId ? "isSelected" : ""}`} type="button" role="row" aria-label={`预览 ${skill.name}`} onClick={() => void openSkill(skill.skillId)} key={skill.skillId}><span role="cell"><Layers aria-hidden="true" /><strong>{skill.name}</strong></span><span role="cell">{skill.description}</span><span role="cell">{skill.skillId.startsWith("system:") ? "系统" : "插件"}</span><span role="cell">{skill.allowImplicitInvocation ? "自动" : "显式"}</span></button>)}
                    {!visibleSkills.length && normalizedCatalogQuery ? <p className="libraryCatalogNoMatch">没有匹配的 Skill</p> : null}
                  </div> : null}
                </>}
        </div>
        </section>

        <aside className={`librarySkillPeek ${selectedSkillId ? "isOpen" : ""}`} aria-label="Skill 预览" aria-hidden={!selectedSkillId}>
          <header><button className="quietCloseButton" type="button" aria-label="关闭 Skill 预览" onClick={() => setSelectedSkillId("")}><X aria-hidden="true" /></button><span>Skill</span></header>
          {skillDetailLoading ? <div className="librarySkillPeekState" role="status" aria-live="polite"><LoaderCircle className="statusIcon" aria-hidden="true" />正在打开 Skill</div> : null}
          {skillDetailError ? <div className="errorBanner libraryError" role="alert">{skillDetailError}</div> : null}
          {skillDetail ? <div className="librarySkillPeekScroll">
            <div className="librarySkillBanner"><Layers aria-hidden="true" />此文件作为 Skill 挂载给代理</div>
            <section className="librarySkillSummary">
              <span className="librarySkillIcon"><Layers aria-hidden="true" /></span>
              <h2>{skillDetail.skill.name}</h2>
              <p>{skillDetail.skill.description}</p>
              <dl>
                <div><dt>来源</dt><dd>{skillDetail.skill.skillId.startsWith("system:") ? "系统挂载" : "插件挂载"}</dd></div>
                <div><dt>调用</dt><dd>{skillDetail.skill.allowImplicitInvocation ? "自动或显式" : "仅显式"}</dd></div>
                <div><dt>允许工具</dt><dd>{skillDetail.skill.allowedTools.length ? skillDetail.skill.allowedTools.join(" · ") : "未限制"}</dd></div>
              </dl>
            </section>
            <article className="librarySkillDocument"><SkillMarkdown content={skillDetail.content} /></article>
          </div> : null}
        </aside>
      </div>

      {dialog && <div className="libraryDialogBackdrop" role="presentation" onMouseDown={closeDialog}>
        <section className={`libraryDialog ${dialog === "move" ? "libraryMoveDialog" : ""} ${dialog === "upload" ? "libraryUploadDialog" : ""}`} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="library-dialog-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
          {dialog === "upload" && <>
            <header className="libraryUploadHeader"><div><h2 id="library-dialog-title">上传文件</h2><p>添加到{folderPath.length ? `“${folderPath.at(-1).displayName}”` : "我的资料"}</p></div><span>{uploadQueue.length}/{MAX_UPLOAD_BATCH_FILES}</span></header>
            <div
              className={`libraryUploadDropzone ${uploadDragActive ? "is-dragging" : ""}`}
              role="button"
              tabIndex={uploading ? -1 : 0}
              aria-disabled={uploading}
              onClick={() => !uploading && fileInputRef.current?.click()}
              onKeyDown={(event) => { if (!uploading && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); fileInputRef.current?.click(); } }}
              onDragEnter={(event) => { event.preventDefault(); if (!uploading) setUploadDragActive(true); }}
              onDragOver={(event) => { event.preventDefault(); if (!uploading) { event.dataTransfer.dropEffect = "copy"; setUploadDragActive(true); } }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setUploadDragActive(false); }}
              onDrop={(event) => { event.preventDefault(); setUploadDragActive(false); addUploadFiles(event.dataTransfer.files); }}
            >
              <span className="libraryUploadDropIcon"><Upload aria-hidden="true" /></span>
              <strong>{uploadDragActive ? "松开即可加入队列" : "拖入一个或多个文件"}</strong>
              <p>或者点击这里，每次选择一个文件</p>
            </div>
            <input ref={fileInputRef} className="srOnly" type="file" aria-label="选择一个文件" disabled={uploading} onChange={selectUploadFile} />
            {uploadDialogError && <div className="libraryUploadError" role="alert">{uploadDialogError}</div>}
            {uploadQueue.length ? <div className="libraryUploadQueue" aria-label="上传队列">{uploadQueue.map((file) => <div className="libraryUploadQueueItem" key={uploadFileKey(file)}><span><FileText aria-hidden="true" /></span><div><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></div><button type="button" disabled={uploading} onClick={() => removeUploadFile(file)} aria-label={`移除 ${file.name}`}><X aria-hidden="true" /></button></div>)}</div> : null}
            <div className="libraryDialogActions libraryUploadActions"><button type="button" disabled={uploading} onClick={closeUploadDialog}>取消</button><button className="primary" type="button" disabled={uploading || !uploadQueue.length} aria-live="polite" onClick={uploadQueuedFiles}>{uploading ? <><LoaderCircle className="statusIcon" aria-hidden="true" />正在上传</> : `上传 ${uploadQueue.length} 个文件`}</button></div>
          </>}
          {dialog === "folder" && <><h2 id="library-dialog-title">新建文件夹</h2><input autoFocus value={dialogTitle} onChange={(event) => setDialogTitle(event.target.value)} placeholder="文件夹名称" /><div className="libraryDialogActions"><button type="button" onClick={() => setDialog("")}>取消</button><button className="primary" type="button" disabled={working || !dialogTitle.trim()} onClick={createFolder}>创建</button></div></>}
          {dialog === "move" && <><header className="libraryMoveHeader"><h2 id="library-dialog-title">移动到…</h2><button type="button" onClick={() => setDialog("")} aria-label="关闭移动"><X aria-hidden="true" /></button></header><button className="libraryMoveRoot" type="button" onClick={() => loadMoveDirectory("")}>库</button>{error && <div className="errorBanner" role="alert">{error}</div>}<div className="libraryMoveObjects">{moveLoading ? <div className="libraryEmptyState" role="status" aria-live="polite"><LoaderCircle className="statusIcon" aria-hidden="true" />正在读取目录</div> : moveObjects.map((item) => { const ItemIcon = isFolder(item) ? Folder : isImage(item) ? ImageIcon : FileText; const disabled = !isFolder(item) || selectedIds.includes(item.id); return isFolder(item) ? <button className="libraryMoveObject folder" type="button" key={item.id} disabled={disabled} onClick={() => loadMoveDirectory(item.id)}><ItemIcon aria-hidden="true" /><span>{item.displayName}</span></button> : <div className="libraryMoveObject file" key={item.id}><ItemIcon aria-hidden="true" /><span>{item.displayName}</span></div>; })}</div><footer className="libraryMoveActions">{creatingMoveFolder ? <form className="libraryMoveCreate" onSubmit={(event) => { event.preventDefault(); createMoveFolder(); }}><input autoFocus value={moveFolderName} onChange={(event) => setMoveFolderName(event.target.value)} placeholder="新建文件夹名称" /><button className="primary" type="submit" disabled={working || !moveFolderName.trim()}>创建</button></form> : <button type="button" disabled={working} onClick={() => { setError(""); setCreatingMoveFolder(true); }}>新建文件夹</button>}<span /><button type="button" onClick={() => setDialog("")}>取消</button><button className="primary" type="button" disabled={working || moveLoading} onClick={moveSelected}>移动到这里</button></footer></>}
          {dialog === "agent" && <><h2 id="library-dialog-title">选择代理</h2><div className="libraryAgentChoices">{agents.map((agent) => <button type="button" key={agent.id} onClick={() => void createChat(agent.id)}>{agent.name}</button>)}</div><div className="libraryDialogActions"><button type="button" onClick={() => setDialog("")}>取消</button></div></>}
        </section>
      </div>}
    </ShellPage>
  );
}

export default function LibraryPage() {
  return <LibraryPageContent />;
}
