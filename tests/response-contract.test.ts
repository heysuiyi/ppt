import { describe, expect, it } from "vitest";
import {
  applyResponseContract,
  buildResponseContract,
} from "../src/main/agent/gateway/response-contract";
import { buildContentBlockResponseGuidance } from "../src/main/plugins/ppt/prompts/response-guidance";

describe("response contracts", () => {
  it("defines native ContentBlock guidance without a JSON envelope", () => {
    const guidance = buildContentBlockResponseGuidance();
    expect(guidance).toContain("直接输出 Markdown 文本");
    expect(guidance).toContain("provider 原生 tool_use");
    expect(guidance).not.toContain('"kind"');
    expect(guidance).not.toContain("assistant.message");
  });

  it("keeps calls without a specialized contract unchanged", () => {
    expect(applyResponseContract("system", "none")).toBe("system");
    expect(applyResponseContract("system", undefined)).toBe("system");
  });

  it("keeps markdown-summary as a separate one-shot constraint", () => {
    const contract = buildResponseContract("markdown-summary");
    expect(contract).toContain("RESPONSE_CONTRACT:markdown-summary");
    expect(contract).toContain("plain Markdown summary text only");
    expect(contract).not.toContain("JSON envelope");
  });

  it("defines a general Markdown-only one-shot constraint", () => {
    const contract = buildResponseContract("markdown");
    expect(contract).toContain("RESPONSE_CONTRACT:markdown");
    expect(contract).toContain("Return Markdown text only");
    expect(applyResponseContract(contract, "markdown")).toBe(contract);
  });
});
