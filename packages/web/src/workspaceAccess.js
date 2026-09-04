import { apiJson, requireWorkspaces } from "./api";

export async function redirectAfterWorkspaceNotFound(workspace, navigate) {
  let destination = "/workspaces";
  let message = `你已不再是 ${workspace.name} 的成员。`;
  try {
    const result = await apiJson("/api/workspaces");
    if (requireWorkspaces(result.workspaces).some((item) => item.id === workspace.id)) {
      destination = `/w/${encodeURIComponent(workspace.id)}/app`;
      message = "你已没有权限访问工作区设置。";
    }
  } catch {
    // The chooser performs its own authenticated reload and remains the safe destination.
  }
  navigate(destination, { replace: true, state: { workspaceNotice: message } });
}
