import type { DisplayEvent } from "@shared/card-display-protocol";
import type React from "react";
import { useState } from "react";
import { Button } from "./Button";
import { ResolvedCard } from "./ResolvedCard";

type PatchEvent = Extract<DisplayEvent, { kind: "review.patch-ready" }>;
type PatchData = PatchEvent["payload"] & { resolved?: "accepted" | "rejected" };

interface PatchReviewCardProps {
  patch: PatchData;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
}

export const PatchReviewCard: React.FC<PatchReviewCardProps> = ({
  patch,
  busy,
  onAccept,
  onReject,
}) => {
  const [expanded, setExpanded] = useState(false);
  const isResolved = Boolean(patch.resolved);
  const canShowDiff = Boolean(
    patch.contentBefore !== undefined && patch.contentAfter !== undefined,
  );

  if (patch.resolved) {
    return (
      <ResolvedCard
        label="产物变更"
        title={patch.resolved === "accepted" ? "已接受" : "已拒绝"}
        detail={patch.targetPath}
      />
    );
  }

  const renderDiffPreview = () => {
    if (!canShowDiff) return null;

    const beforeLines = (patch.contentBefore ?? "").split("\n");
    const afterLines = (patch.contentAfter ?? "").split("\n");
    const previewLimit = expanded ? undefined : 8;

    const renderColumn = (lines: string[], variant: "before" | "after") => (
      <div className={`patch-diff-column patch-diff-column-${variant}`}>
        <h5 className="patch-diff-label">{variant === "before" ? "变更前" : "变更后"}</h5>
        {(previewLimit ? lines.slice(0, previewLimit) : lines).map((line, index) => (
          // Diff lines are positional; identical blank/repeated lines have no stable id.
          // biome-ignore lint/suspicious/noArrayIndexKey: ordered line preview
          <div key={index} className={`patch-diff-line patch-diff-line-${variant}`}>
            {variant === "before" ? "- " : "+ "}
            {line || " "}
          </div>
        ))}
        {previewLimit && lines.length > previewLimit && (
          <div className="patch-diff-truncated">… 还有 {lines.length - previewLimit} 行</div>
        )}
      </div>
    );

    return (
      <div className="patch-diff-grid">
        {renderColumn(beforeLines, "before")}
        {renderColumn(afterLines, "after")}
      </div>
    );
  };

  return (
    <div className="patch-review-card">
      <div className="patch-review-header">
        <span className="patch-review-badge">PATCH</span>
        <span className="patch-review-target">{patch.targetPath}</span>
        {isResolved && (
          <span className={`patch-resolved-badge patch-resolved-${patch.resolved}`}>
            {patch.resolved === "accepted" ? "已接受" : "已拒绝"}
          </span>
        )}
      </div>

      <p className="patch-review-summary">{patch.summary || "AI 建议修改此产物文件"}</p>

      {canShowDiff && (
        <>
          {renderDiffPreview()}
          {(patch.contentBefore ?? "").split("\n").length > 8 ||
          (patch.contentAfter ?? "").split("\n").length > 8 ? (
            <Button variant="quiet" size="sm" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "收起 diff" : "展开完整 diff"}
            </Button>
          ) : null}
        </>
      )}

      {!isResolved && (
        <div className="patch-review-buttons">
          <Button disabled={busy} onClick={onReject}>
            拒绝变更
          </Button>
          <Button disabled={busy} onClick={onAccept} data-theme-emphasis="primary">
            确认接受
          </Button>
        </div>
      )}
    </div>
  );
};
