import { memo, useId } from "react";
import { Brain, ChevronDown } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent";
import { reasoningPreview } from "./reasoningPreview";
import type { ReasoningBlockView } from "./sessionEvents";

export const ReasoningBlock = memo(function ReasoningBlock({ block, expanded, onToggle }: {
  block: ReasoningBlockView;
  expanded: boolean;
  onToggle: () => void;
}) {
  const bodyId = useId();
  const label = block.status === "streaming" ? "正在思考" : "思考";
  return (
    <div className="workspaceReasoning">
      <button type="button" className="workspaceActivityGroup"
        aria-label={label}
        aria-expanded={expanded} aria-controls={bodyId} onClick={onToggle}>
        <Brain aria-hidden="true" />
        <span>{label}</span>
        {!expanded && block.status === "streaming" ? <span className="reasoningPreview" aria-hidden="true"><span className="reasoningPreviewText">{reasoningPreview(block.text)}</span></span> : null}
        <ChevronDown className={`workspaceActivityGroupChevron ${expanded ? "isExpanded" : ""}`} aria-hidden="true" />
      </button>
      {expanded ? <div id={bodyId} className="workspaceReasoningBody" role="region" aria-label="思考内容" tabIndex={0}><MarkdownContent text={block.text} /></div> : null}
    </div>
  );
});
