/** Main-agent guidance for the sole native ContentBlock protocol. */
export function buildContentBlockResponseGuidance(): string {
  return [
    "## 响应协议",
    "",
    "- 普通最终回复直接输出 Markdown 文本；不要包装 JSON、kind/format/type/data 或代码块。",
    "- 调用能力必须使用 provider 原生 tool_use；不要在文本中伪造工具调用 JSON。",
    "- 请求用户补充或提交幻灯片修改时，必须使用本 Query 工具清单中对应的受控能力；能力不可用时不得伪造结果。",
    "- 每个 tool_use 由系统按 ID 回填一个 tool_result；不要自行输出 tool_result。",
    "- 需要行动时优先发出工具调用；参数已知的调用继续同批。阶段切换或本轮将发出 tool_use 时，须先输出 1–2 句可见 Markdown 意图（例如要查看什么、接着进入哪一阶段），再发本批工具；不要把意图只写在思考通道里，也不要逐条复述即将调用的工具名。",
    "- 禁止“继续推进 / 接着我将…”类空洞套话；不要为旁白把可同批的独立工具拆成多轮。开场目标、用户决策与收尾交付仍须写正文。",
  ].join("\n");
}
