
import { useTranslation } from "../i18n";
import { useState } from "react";
import { useRouteLoaderData } from "react-router";
import { PanelLeft } from "lucide-react";
import { ShellSidebar } from "./ShellSidebar";

export function ShellPage({ children, initialTab = "home" }) {
  const { t } = useTranslation();
  const { workspace, agents } = useRouteLoaderData("workspace");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  return (
    <div className={`shShellPage ${sidebarOpen ? "isSidebarOpen" : "isSidebarClosed"}`}>
      <a className="shSkipLink" href="#workspace-main">{t("shellPage.skipToMainContent")}</a>
      <ShellSidebar workspace={workspace} agents={agents} initialTab={initialTab} onCollapse={() => setSidebarOpen(false)} />
      <main className="shMain" id="workspace-main" tabIndex="-1">
        {!sidebarOpen ? <button className="shSidebarOpen" type="button" aria-label={t("appRoute.showSidebar")} title={t("appRoute.showSidebar")} onClick={() => setSidebarOpen(true)}><PanelLeft aria-hidden="true" /></button> : null}
        {children}
      </main>
    </div>
  );
}
