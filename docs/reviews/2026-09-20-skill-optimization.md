# PPT Skill 精简与证据驱动执行

本次参考用户提供的 verify 主技能、CLI 示例、server/API 示例，优化 `skills/` 下 12 份技能。借鉴的是明确入口、实际操作、可观察证据、失败处理与停止条件；没有照搬其“CI 已运行所以不要测试”的环境假设，也没有照搬无边界的扩展探索要求。

## 改动

- workflow 只保留路径与依赖，不重复展开所有作者技能。信息足以执行时提交真实工具调用，不先在分析或正文中重写整套文件或模拟工具结果。
- design、layout 以可执行文件为终点，保留 JSON 契约示例，删除重复设计论证和固定节奏配额。
- build 按当前批次落盘、看实际 PNG、针对缺陷修复；保留 P01 先行、当前版本预览、完整页面提交和锁文件一致性要求。
- review 以实际页面问题为依据，区分质量缺陷、可选建议与证据缺失。修复“可走 edit/restyle 直接修复”与“必须先正式报告”的冲突，不改 capability 权限。
- edit 同步修改后的 finalCopy，只检查实际改动；beautify 达到用户要求后停止装饰性修改。
- outline 不按固定 Hook/Context/Takeaway 页数扩页；brief、storyboard、research 增加可观察产物与停止条件；export 不自动触发正式 review，仍以真实导出事实为准。

核心五份（workflow、design、design-layout、build、review）由 20,812 字符减少至 10,090 字符，约减少 51.5%。按统一 LF 的整份文件计数，含 frontmatter；这是字符量，不是 token 数或运行成本测量。

## 验证

| 检查 | 结果 | 证据 |
|---|---|---|
| 项目实际 scanner 加载 12 份 skill、必需元数据、JSON 示例保留 | PASS（配置检查） | `logs/skill-optimization-validation.txt` |
| `npm.cmd run typecheck` | PASS | `logs/skill-optimization-typecheck.txt` |
| `npm.cmd test` | 165 文件通过；1121 测试通过、1 跳过 | `logs/skill-optimization-tests.txt` |
| skills 差异空白检查 | PASS | `git diff --check -- skills` |
| skill-creator 的 quick_validate.py | 未完成：捆绑 Python 缺少 PyYAML | 未安装额外依赖；该通用校验器也不接受本项目原有 stages/when_to_use 字段，保留项目格式并以项目 scanner 检查兼容性 |
| 真实模型的思考量、首次实际动作延迟与页面质量 | 未运行，不能判定行为收益 | 本次未调用真实模型；先前模拟网关验证不能替代此次 skill 行为验证 |

项目 scanner 检查是内部配置验证，不是 verify 所定义的 Agent 表面行为验证。没有把单测通过、文件变短或人工检查当成模型效果已通过。

后续行为对比应保持模型、输入、预算和模板一致，观察实际工具调用、思考 token/字符、完成状态与 PNG 质量。至少覆盖三页新建、只改一页、只审查三个路径；思考量下降但页面缺失或质量下降不能判为优化成功。

本次只修改技能和本说明，保留进入任务前已有的代码、测试及其他文档修改。
