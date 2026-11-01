import { describe, expect, it } from "vitest";
import {
  confirmProjectFileNavigation,
  formatProjectFileSize,
  groupProjectFiles,
  isBinaryProjectFile,
  projectFileRequiresReload,
  reconcileProjectFileSave,
} from "../app/renderer/src/app/project/projectFilesState";
import type { ProjectArtifact } from "../src/shared/session";

const ARTIFACTS: ProjectArtifact[] = [
  {
    id: "brief",
    title: "需求简报",
    path: "brief.md",
    kind: "reference",
  },
  {
    id: "deck",
    title: "演示文稿",
    path: "deck/",
    kind: "deck",
  },
  {
    id: "export-history",
    title: "导出记录",
    path: "history/exports.json",
    kind: "export-history",
  },
];

describe("project file presentation state", () => {
  it("groups flat paths under file and directory artifacts while preserving empty groups", () => {
    const groups = groupProjectFiles(
      ["./deck/deck.json", "brief.md", "deck/assets/chart.svg", "notes.txt", "deck/deck.json"],
      ARTIFACTS,
    );

    expect(groups.map((group) => group.id)).toEqual([
      "brief",
      "deck",
      "export-history",
      "__other__",
    ]);
    expect(groups.find((group) => group.id === "brief")?.files).toEqual(["brief.md"]);
    expect(groups.find((group) => group.id === "deck")?.files).toEqual([
      "deck/assets/chart.svg",
      "deck/deck.json",
    ]);
    expect(groups.find((group) => group.id === "export-history")?.files).toEqual([]);
    expect(groups.find((group) => group.id === "__other__")?.files).toEqual(["notes.txt"]);
  });

  it("keeps known binary formats out of the UTF-8 editor", () => {
    expect(isBinaryProjectFile("deck/final.PPTX")).toBe(true);
    expect(isBinaryProjectFile("deck/assets/raw.bin")).toBe(true);
    expect(isBinaryProjectFile("deck/assets/photo.webp")).toBe(true);
    expect(isBinaryProjectFile("outline.md")).toBe(false);
    expect(isBinaryProjectFile(".gitignore")).toBe(false);
  });

  it("formats file sizes and recognizes reload-required conflicts", () => {
    expect(formatProjectFileSize(512)).toBe("512 B");
    expect(formatProjectFileSize(1_536)).toBe("1.5 KB");
    expect(formatProjectFileSize(2 * 1_024 * 1_024)).toBe("2.0 MB");
    expect(projectFileRequiresReload({ code: "STALE_FILE" })).toBe(true);
    expect(projectFileRequiresReload(new Error("Edit session expired; read it again."))).toBe(true);
    expect(projectFileRequiresReload(new Error("Permission denied"))).toBe(false);
  });

  it("keeps edits typed while an earlier draft is being saved", () => {
    const previous = {
      path: "brief.md",
      content: "before",
      version: `sha256:${"a".repeat(64)}`,
      mtimeMs: 1,
      size: 6,
      encoding: "utf8" as const,
      newline: "none" as const,
      editToken: "edit-token",
      editable: true,
    };
    const result = {
      path: "brief.md",
      version: `sha256:${"b".repeat(64)}`,
      mtimeMs: 2,
      size: 11,
      encoding: "utf8" as const,
      newline: "none" as const,
      editToken: "edit-token",
      characterCount: 11,
      changed: true,
      changedArtifactId: "brief",
    };

    const withNewTyping = reconcileProjectFileSave(
      previous,
      result,
      "saved draft",
      "saved draft plus new typing",
    );
    expect(withNewTyping.openedFile.content).toBe("saved draft");
    expect(withNewTyping.draft).toBe("saved draft plus new typing");
    expect(withNewTyping.dirty).toBe(true);

    expect(reconcileProjectFileSave(previous, result, "saved draft", "saved draft").dirty).toBe(
      false,
    );
  });

  it("asks before abandoning a dirty project-file draft", () => {
    let confirmations = 0;
    const confirmDiscard = () => {
      confirmations += 1;
      return false;
    };

    expect(confirmProjectFileNavigation(false, confirmDiscard)).toBe(true);
    expect(confirmations).toBe(0);
    expect(confirmProjectFileNavigation(true, confirmDiscard)).toBe(false);
    expect(confirmations).toBe(1);
  });
});
