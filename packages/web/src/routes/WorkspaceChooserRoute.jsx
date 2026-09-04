import { useEffect, useState } from "react";
import { Link, useLoaderData, useLocation, useNavigate } from "react-router";
import { Building2 } from "lucide-react";

const WORKSPACE_ROLE_LABELS = { owner: "所有者", admin: "管理员", member: "成员" };

export default function WorkspaceChooserRoute() {
  const { workspaces } = useLoaderData();
  const location = useLocation();
  const navigate = useNavigate();
  const [notice, setNotice] = useState(() => location.state?.workspaceNotice || "");

  useEffect(() => {
    if (!notice) return undefined;
    if (location.state?.workspaceNotice) {
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    }
    const timeout = window.setTimeout(() => setNotice(""), 4200);
    return () => window.clearTimeout(timeout);
  }, [location.pathname, location.search, location.state, navigate, notice]);

  return (
    <main className="shWorkspaceChooser">
      {notice ? <div className="shWorkspaceToast" role="status">{notice}</div> : null}
      <section>
        <h1>选择工作区</h1>
        {!workspaces.length ? <p>当前账号还没有可访问的工作区。</p> : null}
        <nav aria-label="工作区">
          {workspaces.map((workspace) => (
            <Link to={`/w/${encodeURIComponent(workspace.id)}/app`} key={workspace.id}>
              <span><Building2 aria-hidden="true" /></span>
              <strong>{workspace.name}</strong>
              <small>{WORKSPACE_ROLE_LABELS[workspace.role]}</small>
            </Link>
          ))}
        </nav>
      </section>
    </main>
  );
}
