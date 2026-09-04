import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { Bot, FileText, MessageSquare, Search } from "lucide-react";
import { apiJson } from "../api";
import { useModalDialog } from "../components/useModalDialog";

const KIND_LABEL = { note: "笔记", file: "资料", session: "会话", agent: "代理" };

export function SearchOverlay({ sessions, workspace, agents, agentId, onClose }) {
  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState([]);
  const [loadedSessions, setLoadedSessions] = useState(sessions);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [notePreview, setNotePreview] = useState("");
  const navigate = useNavigate();
  const dialogRef = useModalDialog({ onClose });

  useEffect(() => {
    let active = true;
    apiJson("/api/library")
      .then((result) => { if (active) setLibrary(result.objects || []); })
      .catch(() => { if (active) setLibrary([]); });
    if (!sessions.length && workspace.id && agentId) {
      apiJson(`/api/workspaces/${workspace.id}/sessions?agentId=${encodeURIComponent(agentId)}`)
        .then((result) => { if (active) setLoadedSessions(result.sessions || []); })
        .catch(() => { if (active) setLoadedSessions([]); });
    }
    return () => { active = false; };
  }, [sessions, workspace.id, agentId]);

  const groups = useMemo(() => {
    const text = query.trim().toLocaleLowerCase();
    const matches = (value) => !text || value.toLocaleLowerCase().includes(text);
    return [
      {
        label: "笔记与资料",
        icon: FileText,
        results: library
          .filter((item) => item.objectKind !== "folder" && matches(item.displayName || ""))
          .slice(0, 12)
          .map((item) => ({
            key: `library:${item.id}`,
            id: item.id,
            kind: item.objectKind === "note" ? "note" : "file",
            title: item.displayName,
            detail: item.objectKind === "note" ? "Markdown 笔记" : item.contentType || "资料",
            href: `/w/${encodeURIComponent(workspace.id)}/library/${item.id}`,
          })),
      },
      {
        label: "会话",
        icon: MessageSquare,
        results: loadedSessions
          .filter((session) => matches(session.title || ""))
          .slice(0, 12)
          .map((session) => ({ key: `session:${session.id}`, id: session.id, kind: "session", title: session.title || "未命名会话", detail: "代理会话", href: `/w/${encodeURIComponent(workspace.id)}/agents/${encodeURIComponent(session.agentId)}?sessionId=${encodeURIComponent(session.id)}` })),
      },
      {
        label: "代理",
        icon: Bot,
        results: agents
          .filter((agent) => matches(`${agent.name} ${agent.description}`))
          .map((agent) => ({ key: `agent:${agent.id}`, id: agent.id, kind: "agent", title: agent.name, detail: agent.description, href: `/w/${encodeURIComponent(workspace.id)}/agents/${encodeURIComponent(agent.id)}` })),
      },
    ];
  }, [agents, library, loadedSessions, query, workspace.id]);
  const results = groups.flatMap((group) => group.results.map((result) => ({ ...result, icon: group.icon })));
  const selected = results[Math.min(selectedIndex, Math.max(0, results.length - 1))];

  useEffect(() => setSelectedIndex(0), [query, library, loadedSessions]);

  useEffect(() => {
    let active = true;
    setNotePreview("");
    if (selected?.kind === "note") {
      apiJson(`/api/library/${selected.id}/note`)
        .then((result) => { if (active) setNotePreview(result.markdown || ""); })
        .catch(() => { if (active) setNotePreview(""); });
    }
    return () => { active = false; };
  }, [selected?.id, selected?.kind]);

  function open(result = selected) {
    if (!result) return;
    onClose();
    navigate(result.href);
  }

  function handleKeyDown(event) {
    if (event.key === "ArrowDown" && results.length) {
      event.preventDefault();
      setSelectedIndex((index) => (index + 1) % results.length);
    }
    if (event.key === "ArrowUp" && results.length) {
      event.preventDefault();
      setSelectedIndex((index) => (index - 1 + results.length) % results.length);
    }
    if (event.key === "Enter") {
      event.preventDefault();
      open();
    }
  }

  return createPortal(
    <div className="shSearchBackdrop" role="presentation" onMouseDown={onClose}>
      <section className="shSearchDialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label="聚合搜索" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="shSearchInputRow">
          <Search aria-hidden="true" />
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="在工作区中搜索…" aria-label="搜索会话和笔记" />
        </div>
        <div className="shSearchFilters"><span>仅搜索标题与已加载说明</span><span>会话 · 笔记 · 代理</span></div>
        <div className="shSearchBody">
          <div className="shSearchResults" role="listbox" aria-label="搜索结果">
            {groups.map(({ label, icon: Icon, results: groupResults }) => groupResults.length ? (
              <section key={label}>
                <header>{label}</header>
                {groupResults.map((result) => {
                  const index = results.findIndex((item) => item.key === result.key);
                  return (
                    <button className={index === selectedIndex ? "isSelected" : ""} type="button" role="option" aria-selected={index === selectedIndex} key={result.key} onMouseEnter={() => setSelectedIndex(index)} onFocus={() => setSelectedIndex(index)} onClick={() => open(result)}>
                      <Icon aria-hidden="true" />
                      <span><strong>{result.title}</strong><small>{result.detail}</small></span>
                    </button>
                  );
                })}
              </section>
            ) : null)}
            {!results.length ? <p className="shSearchEmpty">没有匹配的内容</p> : null}
          </div>
          <aside className="shSearchPreview" aria-label="搜索结果预览">
            {selected ? (
              <>
                <div className="shSearchPreviewCover" />
                <div className="shSearchPreviewContent">
                  <span className="shSearchPreviewKind">{KIND_LABEL[selected.kind]}</span>
                  <h2>{selected.title}</h2>
                  {notePreview ? <pre>{notePreview}</pre> : <p>{selected.preview || selected.detail}</p>}
                </div>
              </>
            ) : <p className="shSearchEmpty">输入关键词开始搜索</p>}
          </aside>
        </div>
        <footer className="shSearchFoot"><span>↑↓ 选择</span><span>Enter 打开</span><span>Esc 关闭</span></footer>
      </section>
    </div>,
    document.body,
  );
}
