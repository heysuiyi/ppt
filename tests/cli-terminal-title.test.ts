import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { TerminalView } from "../cli/terminal/renderer-contract.js";
import { visibleWidth } from "../cli/terminal/terminal-text.js";
import { TerminalTitle } from "../cli/terminal/terminal-title.js";

const idle: TerminalView = {
  phase: "idle",
  scene: "conversation",
  input: { purpose: "composer", status: "", hint: "" },
  composer: {
    draft: { text: "未发送草稿", cursor: 5 },
    editable: true,
    submission: { enabled: true },
  },
  context: { workspace: process.cwd(), threadId: "thread", model: "model", capabilities: "" },
};

/** Window title/progress operations, independent of the display-cell emulator. */
class TitleScreen {
  title = "parent shell";
  readonly seen: string[] = [];
  readonly stack: string[] = [];
  writes = 0;
  progress: "none" | "indeterminate" = "none";

  write = async (text: string): Promise<void> => {
    this.writes += 1;
    for (const match of text.matchAll(
      /\x1b(?:\]0;([^\x07]*)\x07|\[(22|23);2t|\]9;4;([03]);?\x07)/gu,
    )) {
      if (match[3]) this.progress = match[3] === "3" ? "indeterminate" : "none";
      else if (match[2] === "22") this.stack.push(this.title);
      else if (match[2] === "23") this.title = this.stack.pop() ?? this.title;
      else {
        this.title = match[1]!;
        this.seen.push(this.title);
      }
    }
  };
}

describe("terminal tab title", () => {
  it("keeps native progress active through execution and clears it before handing back the tab", async () => {
    const screen = new TitleScreen();
    const title = new TerminalTitle(true, screen.write);
    await title.update(idle);
    expect(screen.progress).toBe("none");
    for (const phase of ["submitting", "running", "cancelling", "settling"] as const) {
      await title.update({ ...idle, phase });
      expect(screen.progress).toBe("indeterminate");
    }
    const writes = screen.writes;
    await title.update({ ...idle, phase: "settling" });
    expect(screen.writes).toBe(writes);
    await title.close();
    expect(screen.progress).toBe("none");
    expect(screen.title).toBe("parent shell");
    await title.update({ ...idle, phase: "running" });
    expect(screen.progress).toBe("none");
  });

  it("clears progress for waiting, secret prompts, completion and session switches", async () => {
    const screen = new TitleScreen();
    const title = new TerminalTitle(true, screen.write);
    for (const blocked of [
      { ...idle, phase: "waiting" as const },
      { ...idle, phase: "running" as const, prompt: { secret: true, text: "API key" } },
      idle,
    ]) {
      await title.update({ ...idle, phase: "running" });
      expect(screen.progress).toBe("indeterminate");
      await title.update(blocked);
      expect(screen.progress).toBe("none");
    }
    await title.update({ ...idle, phase: "running" });
    title.bindSession([]);
    await title.update(idle);
    expect(screen.progress).toBe("none");
    await title.close();
  });

  it("does not claim a tiny viewport but still clears owned progress after shrinking", async () => {
    const screen = new TitleScreen();
    const title = new TerminalTitle(true, screen.write);
    await title.update(idle, false);
    expect(screen.writes).toBe(0);
    await title.update({ ...idle, phase: "running" }, true);
    expect(screen.progress).toBe("indeterminate");
    await title.update({ ...idle, phase: "waiting" }, false);
    expect(screen.progress).toBe("none");
    await title.close();
  });

  it("shows idle, working and attention without exposing drafts or secret prompts", async () => {
    const screen = new TitleScreen();
    const title = new TerminalTitle(true, screen.write);
    await title.update(idle);
    expect(screen.title.endsWith(` > ${basename(resolve(process.cwd()))}`)).toBe(true);
    title.user("修复输入框\n不应出现在标签中的正文");
    await title.update({ ...idle, phase: "running" });
    expect(screen.title).toMatch(/ : 修复输入框$/u);
    await title.update({ ...idle, phase: "waiting" });
    expect(screen.title).toMatch(/ ! 修复输入框$/u);
    await title.update({ ...idle, prompt: { secret: true, text: "PRIVATE_KEY_PROMPT" } });
    expect(screen.title).toMatch(/ ! 修复输入框$/u);
    await title.update(idle);
    expect(screen.title).toMatch(/ > 修复输入框$/u);
    expect(screen.seen.join("\n")).not.toContain("未发送草稿");
    expect(screen.seen.join("\n")).not.toContain("PRIVATE_KEY_PROMPT");
    await title.close();
  });

  it("keeps the first submitted topic and rebinds or resets it on session changes", async () => {
    const screen = new TitleScreen();
    const title = new TerminalTitle(true, screen.write);
    title.user("首个主题");
    title.user("后续消息");
    await title.update(idle);
    expect(screen.title).toMatch(/ > 首个主题$/u);
    title.bindSession([
      { role: "assistant", text: "不是用户主题" },
      { role: "user", text: "恢复的主题" },
      { role: "user", text: "恢复的后续消息" },
    ]);
    await title.update(idle);
    expect(screen.title).toMatch(/ > 恢复的主题$/u);
    title.bindSession([]);
    await title.update(idle);
    expect(screen.title.endsWith(` > ${basename(resolve(process.cwd()))}`)).toBe(true);
    await title.close();
  });

  it("neutralizes terminal and bidi controls and bounds multilingual topics", async () => {
    const screen = new TitleScreen();
    const title = new TerminalTitle(true, screen.write);
    title.user(`标题\x1b]0;INJECTED\x07\u202e${"👩‍💻中文".repeat(100)}`);
    await title.update(idle);
    expect(screen.title).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e]/u);
    expect(screen.title).toContain("\\x1b]0;INJECTED\\a\\u202e");
    expect(visibleWidth(screen.title.replace(/^\S+ [>:!] /u, ""))).toBeLessThanOrEqual(80);
    expect(screen.title.endsWith("…")).toBe(true);
    expect(screen.seen).not.toContain("INJECTED");
    await title.close();
  });

  it("deduplicates redraws, restores the parent title once and ignores late updates", async () => {
    const screen = new TitleScreen();
    const title = new TerminalTitle(true, screen.write);
    await title.update(idle);
    const writes = screen.writes;
    await title.update({
      ...idle,
      composer: { ...idle.composer, draft: { text: "typing", cursor: 6 } },
    });
    expect(screen.writes).toBe(writes);
    await title.close();
    expect(screen.title).toBe("parent shell");
    expect(screen.stack).toEqual([]);
    const closedWrites = screen.writes;
    title.user("too late");
    await title.update({ ...idle, phase: "running" });
    await title.close();
    expect(screen.writes).toBe(closedWrites);
    expect(screen.title).toBe("parent shell");
  });

  it("does not claim or clear titles when disabled or never displayed", async () => {
    for (const enabled of [false, true]) {
      const screen = new TitleScreen();
      const title = new TerminalTitle(enabled, screen.write);
      if (!enabled) {
        title.user("pipe output");
        await title.update(idle);
      }
      await title.close();
      expect(screen.writes).toBe(0);
      expect(screen.title).toBe("parent shell");
    }
  });

  it("still restores an acquired title after a partially failed output write", async () => {
    const screen = new TitleScreen();
    let fail = true;
    const title = new TerminalTitle(true, async (text) => {
      await screen.write(text);
      if (fail) {
        fail = false;
        throw new Error("output failed after write");
      }
    });
    await expect(title.update(idle)).rejects.toThrow("output failed after write");
    await title.close();
    expect(screen.title).toBe("parent shell");
    expect(screen.stack).toEqual([]);
  });
});
