import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useRevalidator } from "react-router";
import { ChevronDown, ChevronRight, LoaderCircle, RotateCcw, Trash2 } from "lucide-react";
import { apiJson } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";

function useTrashFeed(path, field, enabled) {
  const [items, setItems] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [filterOptions, setFilterOptions] = useState({ deletedBy: [], locations: [] });
  const loadingRef = useRef(false);
  const cursorRef = useRef(null);

  const load = useCallback(async (nextCursor = null, replace = false) => {
    if (!enabled || loadingRef.current || (!replace && nextCursor !== cursorRef.current)) return;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    try {
      const separator = path.includes("?") ? "&" : "?";
      const result = await apiJson(`${path}${nextCursor ? `${separator}cursor=${encodeURIComponent(nextCursor)}` : ""}`);
      if (!Array.isArray(result[field]) || typeof result.hasMore !== "boolean" || result.hasMore !== Boolean(result.nextCursor)) throw new Error("trash_page_invalid");
      setItems((current) => replace ? result[field] : [...current, ...result[field]]);
      if (result.filterOptions) setFilterOptions(result.filterOptions);
      cursorRef.current = result.nextCursor;
      setHasMore(result.hasMore);
      setLoaded(true);
    } catch (requestError) {
      setError(requestError.message || "trash_load_failed");
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [enabled, field, path]);

  useEffect(() => {
    if (!enabled) return;
    cursorRef.current = null;
    setItems([]);
    setHasMore(false);
    setLoaded(false);
    setError("");
    void load(null, true);
  }, [enabled, load]);

  return {
    items, loaded, loading, error, hasMore, filterOptions,
    remove: (id) => setItems((current) => current.filter((item) => item.id !== id)),
    reload: () => load(null, true),
    retry: () => load(cursorRef.current, !cursorRef.current),
    loadMore: () => cursorRef.current && load(cursorRef.current),
  };
}

function LazySentinel({ feed }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !feed.hasMore) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) feed.loadMore();
    }, { rootMargin: "120px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [feed.hasMore, feed.loadMore]);
  if (!feed.hasMore) return null;
  return <div className="shTrashSentinel" ref={ref}>{feed.loading ? <LoaderCircle className="statusIcon" aria-label="正在加载" /> : null}</div>;
}

function RemainingDays({ deletedAt }) {
  const deleted = new Date(deletedAt).valueOf();
  if (!Number.isFinite(deleted)) return <span>删除时间未知</span>;
  const days = Math.max(1, Math.ceil((deleted + 30 * 86400000 - Date.now()) / 86400000));
  return <span>还剩 {days} 天</span>;
}

function TrashMetadata({ item }) {
  return <small>
    {item.location?.label || "原位置未知"} · {item.deletedBy?.email || "删除者未知"} · <RemainingDays deletedAt={item.deletedAt} />
  </small>;
}

function RowActions({ label, busy, onRestore, onPurge }) {
  return <span className="shTrashActions">
    <button type="button" disabled={busy} aria-label={`恢复${label}`} title="恢复" onClick={onRestore}><RotateCcw aria-hidden="true" /></button>
    <button type="button" disabled={busy} aria-label={`永久删除${label}`} title="永久删除" onClick={onPurge}><Trash2 aria-hidden="true" /></button>
  </span>;
}

function TrashSection({ feed, children }) {
  if (feed.loaded && !feed.items.length && !feed.error) return null;
  return <section className="shTrashSection">
    <div className="shTrashSectionBody">
      {feed.items.map(children)}
      {feed.error ? <button className="shTrashRetry" type="button" onClick={feed.retry}>读取失败，重试</button> : null}
      <LazySentinel feed={feed} />
    </div>
  </section>;
}

function AgentTrashFolder({ item, base, busy, onClose, onRestore, onPurge, onPurgeSession }) {
  const [expanded, setExpanded] = useState(false);
  const feed = useTrashFeed(`/api/agents/${encodeURIComponent(item.id)}/trash/sessions`, "sessions", expanded);
  return <article className="shTrashFolder">
    <div className="shTrashRow">
      <button className="shTrashFolderToggle" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        <span><strong>{item.title}</strong><TrashMetadata item={item} /></span>
      </button>
      <RowActions label={item.title} busy={busy} onRestore={() => onRestore("agent", item)} onPurge={() => onPurge("agent", item)} />
    </div>
    {expanded ? <div className="shTrashChildren">
      {feed.items.map((session) => <div className="shTrashChild" key={session.id}>
        <Link to={`${base}/trash/sessions/${encodeURIComponent(session.id)}`} onClick={onClose}><strong>{session.title}</strong><small>{session.status === "deleted" ? "已单独删除" : "随代理隐藏"}</small></Link>
        {session.status === "deleted" ? <button type="button" aria-label={`永久删除${session.title}`} title="永久删除" onClick={() => onPurgeSession(session, feed)}><Trash2 aria-hidden="true" /></button> : null}
      </div>)}
      {feed.loaded && !feed.items.length && !feed.error ? <p>没有会话</p> : null}
      {feed.error ? <button className="shTrashRetry" type="button" onClick={feed.retry}>读取失败，重试</button> : null}
      <LazySentinel feed={feed} />
    </div> : null}
  </article>;
}

function TrashItemRow({ item, base, busy, onClose, onRestore, onPurge }) {
  const content = <span><strong>{item.title}</strong><TrashMetadata item={item} /></span>;
  return <div className="shTrashRow">
    {item.kind === "session"
      ? <Link className="shTrashOpenRow" to={`${base}/trash/sessions/${encodeURIComponent(item.id)}`} onClick={onClose}>{content}</Link>
      : <div className="shTrashOpenRow">{content}</div>}
    <RowActions label={item.title} busy={busy} onRestore={() => onRestore(item.kind, item)} onPurge={() => onPurge(item.kind, item)} />
  </div>;
}

export function TrashPopover({ open, workspace, anchorRef, onClose }) {
  const panelRef = useRef(null);
  const [position, setPosition] = useState(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("");
  const [scope, setScope] = useState("");
  const [location, setLocation] = useState("");
  const [deletedByUserId, setDeletedByUserId] = useState("");
  const revalidator = useRevalidator();
  const base = `/w/${encodeURIComponent(workspace.id)}`;
  const trashPath = useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set("query", search);
    if (kind) params.set("kind", kind);
    if (scope) params.set("scope", scope);
    if (location) {
      const [locationKind, locationId = ""] = location.split("|");
      params.set("locationKind", locationKind);
      if (locationId) params.set("locationId", locationId);
    }
    if (deletedByUserId) params.set("deletedByUserId", deletedByUserId);
    const query = params.toString();
    return `/api/workspaces/${encodeURIComponent(workspace.id)}/trash${query ? `?${query}` : ""}`;
  }, [deletedByUserId, kind, location, scope, search, workspace.id]);
  const trash = useTrashFeed(trashPath, "items", open);
  const [busyKey, setBusyKey] = useState("");
  const [error, setError] = useState("");
  const [purgeTarget, setPurgeTarget] = useState(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchDraft.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return undefined;
    }
    const update = () => {
      if (window.matchMedia("(max-width: 760px)").matches) {
        setPosition({});
        return;
      }
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const left = rect.right + 8;
      setPosition({
        top: rect.top,
        left,
        bottom: "auto",
        width: Math.min(420, window.innerWidth - left - 10),
        maxHeight: Math.min(620, window.innerHeight - rect.top - 10),
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, open]);

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event) => {
      if (!panelRef.current?.contains(event.target) && !event.target.closest("[data-trash-trigger], .themeConfirmBackdrop")) onClose();
    };
    const escape = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", escape);
    };
  }, [onClose, open]);

  async function restore(kind, item) {
    if (busyKey) return;
    setBusyKey(`${kind}:${item.id}`);
    setError("");
    try {
      const endpoint = {
        agent: `/api/agents/${item.id}/restore`,
        session: `/api/sessions/${item.id}/restore`,
        source: `/api/workspaces/${encodeURIComponent(workspace.id)}/sources/${encodeURIComponent(item.id)}/restore`,
        library: `/api/library/${item.id}/restore`,
      }[kind];
      await apiJson(endpoint, { method: "POST" });
      trash.remove(item.id);
      if (kind === "agent") {
        await trash.reload();
        await revalidator.revalidate();
      }
    } catch (requestError) {
      if (requestError.status === 404 || requestError.status === 410 || requestError.message.endsWith("_not_deleted") || requestError.message === "source_not_restorable") await trash.reload();
      else setError(requestError.message === "agent_deleted" ? "请先恢复该会话所属的代理。" : `恢复失败：${requestError.message}`);
    } finally {
      setBusyKey("");
    }
  }

  async function purge(target = purgeTarget) {
    if (!target || busyKey) return;
    const { kind, item, feed } = target;
    setBusyKey(`${kind}:${item.id}`);
    setError("");
    try {
      const endpoint = {
        agent: `/api/agents/${item.id}/trash`,
        session: `/api/sessions/${item.id}/trash`,
        source: `/api/workspaces/${encodeURIComponent(workspace.id)}/sources/${encodeURIComponent(item.id)}/trash`,
        library: `/api/library/${item.id}/trash`,
      }[kind];
      await apiJson(endpoint, { method: "DELETE" });
      (feed || trash).remove(item.id);
      if (kind === "agent") await revalidator.revalidate();
      setPurgeTarget(null);
    } catch (requestError) {
      if (requestError.status === 404 || requestError.status === 410 || requestError.message.endsWith("_not_deleted")) {
        await (feed || trash).reload();
        setPurgeTarget(null);
      } else setError(`永久删除失败：${requestError.message}`);
    } finally {
      setBusyKey("");
    }
  }

  if (!open || position === null) return null;
  const allLoaded = trash.loaded || trash.error;
  const empty = allLoaded && !trash.items.length && !trash.error;
  const purgeTitle = {
    agent: "确定要删除此代理及其对话？",
    session: "确定要删除此对话？",
    source: "确定要删除此来源？",
    library: "确定要删除此资料？",
  }[purgeTarget?.kind] || "确定要删除此项目？";

  return createPortal(<>
    <section className="shTrashPopover" ref={panelRef} role="dialog" aria-label="垃圾桶" style={position}>
      <header><strong>垃圾桶</strong></header>
      <div className="shTrashTools">
        <input aria-label="搜索垃圾桶" placeholder="在垃圾桶中搜索" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} />
        <div className="shTrashFilters">
          <select aria-label="类型" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="">类型</option>
            <option value="agent">代理</option>
            <option value="session">会话</option>
            <option value="source">Source</option>
            <option value="library">Library</option>
          </select>
          <select aria-label="原位置" value={location} onChange={(event) => setLocation(event.target.value)}>
            <option value="">原位置</option>
            {trash.filterOptions.locations.map((item) => <option key={`${item.kind}:${item.id || "root"}`} value={`${item.kind}|${item.id || ""}`}>{item.scope === "privateLibrary" ? "私人" : "工作区"} · {item.label}</option>)}
          </select>
          <select aria-label="范围" value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="">范围</option>
            <option value="privateLibrary">私人 Library</option>
            <option value="workspace">当前工作区</option>
          </select>
          <select aria-label="删除者" value={deletedByUserId} onChange={(event) => setDeletedByUserId(event.target.value)}>
            <option value="">删除者</option>
            {trash.filterOptions.deletedBy.map((item) => <option key={item.userId} value={item.userId}>{item.email}</option>)}
          </select>
        </div>
      </div>
      <div className="shTrashPopoverBody">
        {error ? <div className="errorBanner" role="alert">{error}</div> : null}
        {!allLoaded ? <div className="shTrashLoading"><LoaderCircle className="statusIcon" aria-hidden="true" />正在读取…</div> : null}
        <TrashSection feed={trash}>{(item) => item.kind === "agent"
          ? <AgentTrashFolder key={item.id} item={item} base={base} busy={Boolean(busyKey)} onClose={onClose} onRestore={restore} onPurge={(kind, target) => setPurgeTarget({ kind, item: target })} onPurgeSession={(target, feed) => setPurgeTarget({ kind: "session", item: target, feed })} />
          : <TrashItemRow key={`${item.kind}:${item.id}`} item={item} base={base} busy={Boolean(busyKey)} onClose={onClose} onRestore={restore} onPurge={(kind, target) => setPurgeTarget({ kind, item: target })} />}</TrashSection>
        {empty ? <div className="shTrashAllEmpty"><p>垃圾桶是空的</p></div> : null}
      </div>
      <footer>项目在垃圾桶中保留 30 天，之后自动删除。</footer>
    </section>
    <ConfirmDialog open={Boolean(purgeTarget)} title={purgeTitle} busy={Boolean(busyKey)} onCancel={() => setPurgeTarget(null)} onConfirm={() => void purge()} />
  </>, document.body);
}
