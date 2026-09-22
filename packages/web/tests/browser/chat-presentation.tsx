import { useEffect, useState, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { AnimatedDisclosure } from "../../src/chat/AnimatedDisclosure";
import { WorkProgress } from "../../src/chat/WorkProgress";
import { WorkspaceContextPanel } from "../../src/components/WorkspaceContextPanel";

const results: { name: string; actual: unknown; expected: unknown }[] = [];
for (const theme of ["light", "dark"]) {
  document.documentElement.dataset.theme = theme;
  for (const [id, size] of Object.entries({ user: 14, answer: 14, thought: 14, thoughtLink: 14, code: 13, thoughtCode: 13, tool: 12, work: 12, summary: 12, source: 12, stage: 12, document: 14 })) {
    results.push({ name: `${theme}: ${id} font size`, actual: getComputedStyle(document.getElementById(id)!).fontSize, expected: `${size}px` });
  }
  for (const [id, leading] of Object.entries({ thought: 24, tool: 18, thoughtCode: 21 })) {
    results.push({ name: `${theme}: ${id} line height`, actual: getComputedStyle(document.getElementById(id)!).lineHeight, expected: `${leading}px` });
  }
  const error = document.createElement("div");
  error.className = "filePreviewState isError";
  const reference = document.createElement("span");
  reference.style.color = "var(--danger)";
  document.body.append(error, reference);
  results.push({ name: `${theme}: error remains distinguished`, actual: getComputedStyle(error).color, expected: getComputedStyle(reference).color });
  error.remove(); reference.remove();
}
document.documentElement.dataset.theme = "light";

function check(name: string, actual: unknown, expected: unknown) { results.push({ name, actual, expected }); }
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const render = (node: React.ReactNode) => flushSync(() => root.render(<StrictMode>{node}</StrictMode>));
const settle = () => new Promise(resolve => setTimeout(resolve, 50));
async function finishAnimations() {
  for (const animation of host.getAnimations({ subtree: true })) animation.finish();
  await settle();
}
let mounted = 0;
function Detail() {
  useEffect(() => { mounted++; return () => { mounted--; }; }, []);
  return <p style={{ height: 100 }}>Tool output</p>;
}
try {
  render(<AnimatedDisclosure expanded={false}><Detail /></AnimatedDisclosure>);
  check("closed content is lazy", mounted, 0);
  render(<AnimatedDisclosure expanded><Detail /></AnimatedDisclosure>);
  check("opening mounts content", mounted, 1);
  const opening = host.getAnimations()[0] ?? host.getAnimations({ subtree: true })[0];
  check("opening animates", Boolean(opening), !matchMedia("(prefers-reduced-motion: reduce)").matches);
  await finishAnimations();
  render(<AnimatedDisclosure expanded={false}><Detail /></AnimatedDisclosure>);
  check("closing is immediately inert", host.querySelector(".chatDisclosure")?.hasAttribute("inert"), true);
  const closing = host.getAnimations({ subtree: true })[0];
  if (closing) {
    check("closing retains content during animation", mounted, 1);
    closing.currentTime = 80;
    const height = host.firstElementChild!.getBoundingClientRect().height;
    render(<AnimatedDisclosure expanded><Detail /></AnimatedDisclosure>);
    check("reversal preserves current height", Math.abs(host.firstElementChild!.getBoundingClientRect().height - height) < 2, true);
    await finishAnimations();
    check("stale close does not remove reopened content", mounted, 1);
    render(<AnimatedDisclosure expanded={false}><Detail /></AnimatedDisclosure>);
  }
  await finishAnimations();
  check("closed content releases effects", mounted, 0);
  check("closed disclosure is hidden", (host.firstElementChild as HTMLElement).hidden, true);
  render(<AnimatedDisclosure key="history" expanded><Detail /></AnimatedDisclosure>);
  check("history does not replay entry animation", host.getAnimations({ subtree: true }).length, 0);

  const progress = (finalStarted: boolean, key = "turn") => <WorkProgress key={key} running={!finalStarted} finalStarted={finalStarted}><p>Process</p></WorkProgress>;
  render(progress(false));
  render(progress(true));
  await finishAnimations();
  check("final answer folds process", host.querySelector("button")?.getAttribute("aria-expanded"), "false");
  flushSync(() => (host.querySelector("button") as HTMLButtonElement).click());
  render(progress(false));
  render(progress(true));
  check("reopened process survives refresh", host.querySelector("button")?.getAttribute("aria-expanded"), "true");
  render(progress(true, "other-turn"));
  check("another turn uses its own default", host.querySelector("button")?.getAttribute("aria-expanded"), "false");
  function ReadingDetail() {
    const [open, setOpen] = useState(false);
    return <button aria-expanded={open} onClick={() => setOpen(!open)}>Thoughts</button>;
  }
  const reading = (finalStarted: boolean) => <WorkProgress key="reading" running={!finalStarted} finalStarted={finalStarted}><ReadingDetail /></WorkProgress>;
  render(reading(false));
  flushSync(() => (host.querySelector("button") as HTMLButtonElement).click());
  render(reading(true));
  check("final answer preserves actively opened details", host.querySelector(".workProgressSummary")?.getAttribute("aria-expanded"), "true");

  const preview = (open: boolean) => <div className={`workspaceWorkbench${open ? " withContextPanel withFilePreview" : ""}`}><WorkspaceContextPanel
    panel={open ? { mode: "filePreview", status: "ready", displayName: "Evidence.txt", preview: { kind: "text", content: "Evidence", contentType: "text/plain" } } : { mode: "closed" }}
    browserWidthPx={480} onBrowserWidthChange={() => {}} onClose={() => {}} onReturn={() => {}} /></div>;
  render(preview(false));
  render(preview(true));
  check("preview ready content visible", host.querySelector(".documentTextPreview")?.textContent, "Evidence");
  render(preview(false));
  check("preview close releases file content", host.querySelector(".documentTextPreview"), null);
  check("preview exit shell is inert", host.querySelector("aside")?.hasAttribute("inert"), true);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    check("reduced motion removes exit delay", getComputedStyle(host.querySelector("aside")!).transitionDelay, "0s");
  }
} catch (error) {
  results.push({ name: "browser exception", actual: String(error), expected: "no exception" });
}
root.unmount();
document.getElementById("results")!.textContent = JSON.stringify(results);
