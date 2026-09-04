import { Grid2X2, Search, Sparkles, Table2 } from "lucide-react";
import { AgentMark } from "./AgentMark";

const QUICK_ACTIONS = [
  { label: "创建幻灯片", icon: Grid2X2, prompt: "请帮我创建一份幻灯片，先确认主题、受众和篇幅。" },
  { label: "表格", icon: Table2, prompt: "请帮我整理成表格，先确认字段和数据来源。" },
  { label: "研究", icon: Search, prompt: "请围绕这个主题开始研究，先列出计划与所需资料。" },
  { label: "可视化", icon: Sparkles, prompt: "请把这些信息可视化，先确认最重要的关系。" },
];

export function HomePlane({ agent }) {
  return (
    <div className="shHome" aria-label="主页">
      <AgentMark className="shHomeAvatar" agent={agent} />
    </div>
  );
}

export function HomeQuickActions({ onQuickAction }) {
  return (
    <div className="shQuickActions" aria-label="快捷操作">
        {QUICK_ACTIONS.map(({ label, icon: Icon, prompt }) => (
          <button className="shQuickAction" type="button" key={label} onClick={() => onQuickAction(prompt)}>
            <Icon aria-hidden="true" /><span>{label}</span>
          </button>
        ))}
    </div>
  );
}
