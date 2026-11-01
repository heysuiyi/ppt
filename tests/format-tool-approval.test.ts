import { describe, expect, it } from "vitest";
import { formatToolApprovalDetail } from "../app/main/agent/runtime/tools/format-tool-approval";

describe("formatToolApprovalDetail", () => {
  it("formats bash commands", () => {
    expect(formatToolApprovalDetail("bash", { command: "rm notes.md" })).toBe("rm notes.md");
  });

  it("formats WriteFile with truncated content", () => {
    const content = "a".repeat(300);
    const detail = formatToolApprovalDetail("WriteFile", { path: "x.md", content });
    expect(detail).toContain("path: x.md");
    expect(detail).toContain("...");
  });

  it("formats main-agent workspace file tools with the same readable contract", () => {
    expect(formatToolApprovalDetail("ReadFile", { path: "slides/outline.md" })).toBe(
      "slides/outline.md",
    );
    expect(formatToolApprovalDetail("Glob", { pattern: "slides/**/*.md" })).toBe("slides/**/*.md");
    expect(
      formatToolApprovalDetail("EditFile", {
        path: "slides/outline.md",
        old_string: "old",
        new_string: "new",
      }),
    ).toBe("path: slides/outline.md\n- old\n+ new");
  });
});
