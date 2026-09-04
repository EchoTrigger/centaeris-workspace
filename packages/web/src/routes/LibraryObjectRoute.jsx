import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useRouteLoaderData, useSearchParams } from "react-router";
import { ArrowLeft, Download, FileText, LoaderCircle, LockKeyhole, Trash2 } from "lucide-react";
import { apiJson as api, apiUrl, jsonOptions } from "../api";
import { ShellPage } from "../shell/ShellPage";

function isImage(item) {
  return item.objectKind === "image" || item.contentType.startsWith("image/");
}

function canEmbed(item) {
  return item.contentType === "application/pdf" || item.contentType.startsWith("text/");
}

function splitNote(markdown, fallbackTitle) {
  const heading = markdown.match(/^#\s+([^\n]+)\n?/);
  if (!heading) return { title: fallbackTitle === "Untitled" ? "" : fallbackTitle, body: markdown };
  return { title: heading[1].trim(), body: markdown.slice(heading[0].length).replace(/^\n/, "") };
}

function composeNote(title, body) {
  const cleanTitle = title.trim();
  return cleanTitle ? `# ${cleanTitle}${body ? `\n\n${body}` : ""}` : body;
}

function LibraryPreviewPageContent() {
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { workspace } = useRouteLoaderData("workspace");
  const base = `/w/${encodeURIComponent(workspace.id)}`;
  const [searchParams] = useSearchParams();
  const libraryObjectId = String(params.libraryObjectId || "");
  const folderId = searchParams.get("folder") || "";
  const [item, setItem] = useState(null);
  const [markdown, setMarkdown] = useState("");
  const [noteTitle, setNoteTitle] = useState("");
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const noteRef = useRef({ displayName: "Untitled", markdown: "" });
  const itemIdRef = useRef("");
  const saveTimerRef = useRef(null);
  const saveQueueRef = useRef(Promise.resolve());

  function backToLibrary() {
    navigate(folderId ? `${base}/library?folder=${encodeURIComponent(folderId)}` : `${base}/library`);
  }

  async function load() {
    setLoading(true);
    setError("");
    setSaveStatus("");
    if (libraryObjectId === "new") {
      const draft = location.state?.noteDraft || { name: "Untitled", markdown: "" };
      const note = splitNote(draft.markdown || "", draft.name || "Untitled");
      noteRef.current = { displayName: note.title || "Untitled", markdown: draft.markdown || "" };
      itemIdRef.current = "";
      setItem({ id: "", objectKind: "note", contentType: "text/markdown", displayName: noteRef.current.displayName, status: "draft" });
      setNoteTitle(note.title);
      setMarkdown(note.body);
      setRenamingTitle(true);
      setLoading(false);
      return;
    }
    try {
      const result = await api(`/api/library/${libraryObjectId}`);
      if (result.object.objectKind === "folder") {
        navigate(`${base}/library?folder=${encodeURIComponent(result.object.id)}`, { replace: true });
        return;
      }
      itemIdRef.current = result.object.id;
      setItem(result.object);
      if (result.object.objectKind === "note") {
        const note = await api(`/api/library/${libraryObjectId}/note`);
        const fields = splitNote(note.markdown, result.object.displayName);
        noteRef.current = { displayName: result.object.displayName, markdown: note.markdown };
        setNoteTitle(fields.title);
        setMarkdown(fields.body);
        setRenamingTitle(false);
      }
    } catch (requestError) {
      setError(`无法打开文件：${requestError.message}`);
    } finally {
      setLoading(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: Object identity is the load trigger; the render-local command must not retrigger itself.
  useEffect(() => {
    load();
  }, [libraryObjectId]);

  useEffect(() => () => window.clearTimeout(saveTimerRef.current), []);

  function saveNote() {
    if (!item) return Promise.resolve();
    const snapshot = { ...noteRef.current };
    if (!itemIdRef.current && !snapshot.markdown.trim()) return Promise.resolve();
    const operation = saveQueueRef.current.then(async () => {
      setError("");
      setSaveStatus("正在保存…");
      try {
        const result = itemIdRef.current
          ? await api(`/api/library/${itemIdRef.current}/note`, {
            method: "PUT",
            body: JSON.stringify(snapshot),
            headers: { "Content-Type": "application/json" },
          })
          : await api("/api/library/notes", jsonOptions("POST", {
            displayName: snapshot.displayName,
            markdown: snapshot.markdown,
            parentFolderId: folderId,
          }));
        const created = !itemIdRef.current;
        itemIdRef.current = result.object.id;
        setItem(result.object);
        if (created) {
          navigate(`${base}/library/${encodeURIComponent(result.object.id)}${folderId ? `?folder=${encodeURIComponent(folderId)}` : ""}`, { replace: true, state: null });
        }
        setSaveStatus("已保存。");
      } catch (requestError) {
        setError(`保存失败：${requestError.message}`);
        setSaveStatus("保存失败。");
        throw requestError;
      }
    });
    saveQueueRef.current = operation.catch(() => undefined);
    return operation;
  }

  function scheduleSave() {
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => { void saveNote().catch(() => {}); }, 600);
  }

  function updateNote(title, body) {
    setNoteTitle(title);
    setMarkdown(body);
    setSaveStatus("有未保存的更改。");
    noteRef.current = { displayName: title.trim() || "Untitled", markdown: composeNote(title, body) };
    scheduleSave();
  }

  async function deleteItem() {
    if (!item || deleting) return;
    setDeleting(true);
    try {
      await api(`/api/library/${item.id}`, { method: "DELETE" });
      backToLibrary();
    } catch (requestError) {
      setError(`无法移到垃圾桶：${requestError.message}`);
    } finally {
      setDeleting(false);
    }
  }

  const isNote = item?.objectKind === "note";
  const displayedTitle = isNote ? noteTitle || "无标题" : item?.displayName;

  return <div className="libraryPreviewMain">
    <span className="srOnly" role="status" aria-live="polite">{saveStatus}</span>
    <header className="libraryPreviewHeader">
      {isNote ? <nav className="libraryNoteIdentity" aria-label="笔记地址">
        <button type="button" onClick={backToLibrary}>私人</button>
        <span aria-hidden="true">/</span>
        {renamingTitle
          ? <input
            autoFocus
            value={noteTitle}
            onChange={(event) => updateNote(event.target.value, markdown)}
            onBlur={() => setRenamingTitle(false)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== "Escape") return;
              event.preventDefault();
              setRenamingTitle(false);
            }}
            aria-label="笔记标题"
            placeholder="无标题"
          />
          : <button className="libraryNoteName" type="button" onClick={() => setRenamingTitle(true)} aria-label="重命名笔记">{displayedTitle}</button>}
        <small><LockKeyhole aria-hidden="true" />私人</small>
      </nav> : <nav aria-label="资料库路径"><button type="button" onClick={backToLibrary}><ArrowLeft aria-hidden="true" />资料库</button>{item && <><span>/</span><strong>{displayedTitle}</strong></>}</nav>}
      {item && !isNote && <div className="libraryPreviewActions"><a href={apiUrl(`/api/library/${item.id}/download`)} aria-label="下载"><Download aria-hidden="true" /></a><button type="button" disabled={deleting} onClick={() => void deleteItem()} aria-label="移到垃圾桶"><Trash2 aria-hidden="true" /></button></div>}
    </header>
    <section className={`libraryPreviewBody ${item?.objectKind === "note" ? "libraryNotePreview" : ""}`}>
      {loading ? <div className="libraryEmptyState" role="status" aria-live="polite"><LoaderCircle className="statusIcon" aria-hidden="true" />正在打开文件</div> : <>{error && <div className="errorBanner libraryError" role="alert">{error}<button type="button" onClick={load}>重试</button></div>}{isNote ? <div className="libraryNoteEditor"><textarea value={markdown} onChange={(event) => updateNote(noteTitle, event.target.value)} aria-label="笔记正文" placeholder="输入文字，或键入“/”获取命令…" /></div> : error ? null : isImage(item) ? <img className="libraryPreviewImage" src={apiUrl(`/api/library/${item.id}/preview`)} alt={item.displayName} /> : canEmbed(item) ? <iframe className="libraryPreviewFrame" src={apiUrl(`/api/library/${item.id}/preview`)} title={item.displayName} /> : <div className="libraryPreviewUnsupported"><FileText aria-hidden="true" /><strong>{item.displayName}</strong><span>此文件类型暂不支持在线预览。</span><a href={apiUrl(`/api/library/${item.id}/download`)}><Download aria-hidden="true" />下载文件</a></div>}</>}
    </section>
  </div>;
}

export default function LibraryPreviewPage() {
  return <ShellPage><LibraryPreviewPageContent /></ShellPage>;
}
