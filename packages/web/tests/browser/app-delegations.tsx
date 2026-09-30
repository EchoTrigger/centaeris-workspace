import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createMemoryRouter, RouterProvider } from "react-router";
import AppDelegations from "../../src/routes/AppDelegations";
import SettingsRoute from "../../src/routes/SettingsRoute";
import { configureApi, clearCsrfToken } from "../../src/api";
import { i18n } from "../../src/i18n";

const results: { name: string; actual: unknown; expected: unknown }[] = [];
function check(name: string, actual: unknown, expected: unknown) { results.push({ name, actual, expected }); }
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 50)); flushSync(() => {}); };
const render = (admin = false) => flushSync(() => root.render(<StrictMode><AppDelegations isSuperuser={admin} /></StrictMode>));
const field = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement;
function change(label: string, value: string) {
  const element = field(label);
  Object.getOwnPropertyDescriptor(element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}
function button(text: string) {
  const element = [...host.querySelectorAll("button")].find(item => item.textContent?.includes(text));
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}
const calls: { path: string; method: string; body: unknown; credentials: unknown; csrf: string | null; authorization: string | null }[] = [];
const originalFetch = window.fetch;
let copied = "";
let issueError = "";
let slowDefinitions: ((value: Response) => void) | undefined;
let delayDefinitions = false;
let noMembership = false;
const apps = [{ id: "app-report", name: "Reports", status: "active" }];
let adminApps = [...apps, { id: "app-revoked", name: "Retired", status: "revoked" }];
let grants = [{ id: "grant-orphan", appId: "app-report", appName: "Reports", workspaceId: "workspace-gone", workspaceName: "Former workspace", definitionId: "def-gone", definitionName: "Former assistant", scopes: ["events:read"], issuer: "centaeris-workspace", audience: "centaeris-workspace-api", createdAt: "2026-09-30T00:00:00Z", expiresAt: "2099-10-01T00:00:00Z", revokedAt: null }];
const response = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
window.fetch = async (input, options = {}) => {
  const path = new URL(String(input)).pathname;
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers);
  const body = options.body ? JSON.parse(String(options.body)) : null;
  calls.push({ path, method, body, credentials: options.credentials, csrf: headers.get("X-CSRFToken"), authorization: headers.get("Authorization") });
  if (path === "/api/csrf") return response({ csrfToken: "fixture-csrf" });
  if (path === "/api/business-apps") return response({ apps: apps.filter(app => app.status === "active") });
  if (path === "/api/workspaces") return response({ workspaces: noMembership ? [] : [{ id: "workspace-research", name: "Research", role: "member" }, { id: "workspace-support", name: "Support", role: "member" }] });
  if (path.includes("available-agent-definitions")) {
    if (delayDefinitions && path.includes("workspace-research")) return new Promise(resolve => { slowDefinitions = resolve; });
    return response({ definitions: path.includes("workspace-research") ? [{ id: "version-research", definitionId: "def-research", name: "Research assistant" }] : [{ id: "version-support", definitionId: "def-support", name: "Support assistant" }] });
  }
  if (path === "/api/account/app-delegations" && method === "GET") return response({ delegations: grants });
  if (path === "/api/account/app-delegations" && method === "POST") {
    if (issueError) return response({ error: issueError }, 400);
    const delegation = { ...grants[0], id: "grant-new", workspaceId: body.workspaceId, workspaceName: "Research", definitionId: body.definitionId, definitionName: "Research assistant", scopes: body.scopes };
    grants = [...grants, delegation];
    return response({ delegation, accessToken: "fixture-one-time-token", tokenType: "Bearer" }, 201);
  }
  if (path.startsWith("/api/account/app-delegations/") && method === "DELETE") {
    grants = grants.map(grant => grant.id === path.split("/").at(-1) ? { ...grant, revokedAt: "2026-09-30T01:00:00Z" } : grant);
    return response(null, 204);
  }
  if (path === "/api/admin/business-apps" && method === "GET") return response({ apps: adminApps });
  if (path === "/api/admin/business-apps" && method === "POST") {
    const app = { id: "app-new", name: body.name, status: "pending" };
    adminApps = [...adminApps, app];
    return response({ app }, 201);
  }
  if (path.startsWith("/api/admin/business-apps/") && method === "PATCH") {
    const app = { ...adminApps.find(item => item.id === path.split("/").at(-1))!, status: body.status };
    adminApps = adminApps.map(item => item.id === app.id ? app : item);
    return response({ app });
  }
  throw new Error(`Unexpected fixture request: ${method} ${path}`);
};
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied = value; } } });
configureApi({ apiBaseUrl: "https://fixture.invalid" });
clearCsrfToken();
try {
  await i18n.changeLanguage("en");
  const storageBefore = JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } });
  render(); await settle();
  check("member does not call administrator API", calls.some(call => call.path.startsWith("/api/admin/")), false);
  check("lost membership grant remains visible", host.textContent!.includes("Former workspace"), true);
  check("consent disabled without explicit choices", button("Authorize").disabled, true);
  check("no scopes selected by default", host.querySelectorAll('input[type="checkbox"]:checked').length, 0);
  check("all eight supported scopes offered", host.querySelectorAll('input[type="checkbox"]').length, 8);
  check("expiry defaults to one hour", field("Expiry (seconds)").value, "3600");
  change("Application", "app-report"); change("Workspace", "workspace-research"); await settle();
  change("Assistant", "def-research");
  (field("assistant:use") as HTMLInputElement).click(); (field("sessions:read") as HTMLInputElement).click(); await settle();
  const consent = button("Authorize");
  for (const text of ["Reports", "Research", "Research assistant", "assistant:use", "sessions:read", "3600"]) check(`consent names ${text}`, consent.textContent!.includes(text), true);
  change("Expiry (seconds)", "299"); await settle(); check("too short expiry disabled", button("Authorize").disabled, true);
  change("Expiry (seconds)", "86401"); await settle(); check("too long expiry disabled", button("Authorize").disabled, true);
  change("Expiry (seconds)", "3600"); await settle();
  button("Authorize").click(); await settle();
  const issued = calls.find(call => call.path === "/api/account/app-delegations" && call.method === "POST")!;
  check("issued exact camelCase consent request", issued.body, { appId: "app-report", workspaceId: "workspace-research", definitionId: "def-research", scopes: ["assistant:use", "sessions:read"], expiresInSeconds: 3600 });
  check("mutation uses browser cookie", issued.credentials, "include");
  check("mutation uses CSRF", issued.csrf, "fixture-csrf");
  check("issued token shown once", host.textContent!.includes("fixture-one-time-token"), true);
  button("Copy token").click(); await settle(); check("copy receives token", copied, "fixture-one-time-token");
  check("token never stored", JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }), storageBefore);
  button("Dismiss token").click(); await settle(); check("dismiss clears token", host.textContent!.includes("fixture-one-time-token"), false);
  const orphanRow = [...host.querySelectorAll("article")].find(row => row.textContent!.includes("Former workspace"))!;
  (orphanRow.querySelector("button") as HTMLButtonElement).click(); await settle();
  check("orphan grant revoked with account endpoint", calls.some(call => call.path === "/api/account/app-delegations/grant-orphan" && call.method === "DELETE" && call.csrf === "fixture-csrf"), true);
  check("orphan revoke updates visible status", orphanRow.textContent!.includes("Revoked"), true);
  issueError = "delegation_not_available"; button("Authorize").click(); await settle();
  check("unavailable authorization error readable", host.querySelector('[role="alert"]')?.textContent!.includes("no longer available"), true);
  issueError = "";
  flushSync(() => root.render(null)); render(); await settle();
  check("remount never restores token", host.textContent!.includes("fixture-one-time-token"), false);
  delayDefinitions = true;
  change("Workspace", "workspace-research"); await settle(); change("Workspace", "workspace-support"); await settle();
  slowDefinitions?.(response({ definitions: [{ id: "old-version", definitionId: "old-def", name: "Stale assistant" }] })); await settle();
  check("stale workspace response ignored", host.textContent!.includes("Stale assistant"), false);
  check("current workspace definitions retained", field("Assistant").textContent!.includes("Support assistant"), true);
  render(true); await settle();
  change("Application name", "New integration"); await settle(); button("Register application").click(); await settle();
  const newRow = () => [...host.querySelectorAll("article")].find(row => row.textContent!.includes("New integration"))!;
  check("registration starts pending", newRow().textContent!.includes("Pending"), true);
  (newRow().querySelector('button[data-action="activate"]') as HTMLButtonElement).click(); await settle();
  check("activation visible", newRow().textContent!.includes("Active"), true);
  (newRow().querySelector('button[data-action="revoke"]') as HTMLButtonElement).click(); await settle();
  check("application revoke visible", newRow().textContent!.includes("Revoked"), true);
  check("revoked application has no activation action", newRow().querySelector('button[data-action="activate"]'), null);
  check("all mutations cookie and CSRF authenticated", calls.filter(call => !["GET", "HEAD"].includes(call.method)).every(call => call.credentials === "include" && call.csrf === "fixture-csrf"), true);
  check("UI never uses delegated bearer token for settings", calls.every(call => call.authorization === null), true);
  flushSync(() => root.render(null));
  noMembership = true;
  const router = createMemoryRouter([{ id: "authenticated", HydrateFallback: () => null, loader: () => ({ user: { id: "user-fixture", isSuperuser: false } }), children: [{ path: "/settings/applications", loader: () => ({ workspace: null, workspaces: [] }), Component: SettingsRoute }] }], { initialEntries: ["/settings/applications"] });
  flushSync(() => root.render(<RouterProvider router={router} />)); await settle(); await settle();
  check("account Applications opens without membership", host.querySelector('[role="dialog"]')?.getAttribute("aria-label"), "Applications");
  check("account navigation identifies Applications", host.querySelector('a[aria-current="page"]')?.getAttribute("href"), "/settings/applications");
  check("orphaned grants accessible from account Settings", host.textContent!.includes("Former workspace"), true);
  check("no workspace needed to list authorizations", field("Workspace").querySelectorAll("option").length, 1);
  router.dispose();
} catch (error) {
  check("fixture completed", { error: error instanceof Error ? error.message : String(error), content: host.textContent, calls }, "success");
} finally {
  window.fetch = originalFetch;
  flushSync(() => root.unmount());
  document.getElementById("results")!.textContent = JSON.stringify(results);
}
