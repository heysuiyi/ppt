import { describe, expect, it } from "vitest";
import { completeAskUserMessage } from "../app/main/agent/tools/core/ask-user";

describe("AskUser visible content", () => {
  it("turns missing field metadata into visible prompts when the model only writes an intro", () => {
    expect(
      completeAskUserMessage("这份学习 PPT，我想确认几个方向：", ["audience", "pageCount"]),
    ).toBe("这份学习 PPT，我想确认几个方向：\n\n请补充：目标受众、页数范围。");
  });

  it("does not repeat fields already named in the question", () => {
    expect(completeAskUserMessage("请补充目标受众", ["audience"])).toBe("请补充目标受众");
  });
});
