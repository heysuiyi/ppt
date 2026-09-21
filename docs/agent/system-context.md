# System Prompt 与 Context 管理

> 文档类型：现行架构
> 最后核对：2026-07-30

## 1. 原则

System Prompt 是有序 Section 的组装结果，不是一份不断追加规则的巨型字符串。

当前实现遵守：

- 稳定内容获得稳定前缀和 Prompt Cache；
- workspace、artifact、selection、记忆、工具和预算等动态事实可独立更新；
- 项目指令与系统安全策略分层；
- Skill 提供建议，不编译成隐藏状态机；
- Prompt 只解释能力和偏好，不承担权限与持久化正确性。

## 2. 当前上下文来源与扩展契约

| 类型 | 当前已接入内容 | 注入方式 |
|---|---|---|
| System Prompt | 身份、响应协议、动态工具说明 | Provider system field |
| Dynamic sections | workspace/artifact、当前 slide、memory、预算、required outcome、建议 stage | dynamic system suffix |
| Request context | caller 可选的 `userContext` / `systemContext`、thread/run identity | 临时 user message |
| Canonical messages | 用户消息、assistant ContentBlock、成对工具结果 | Provider messages |

当 Provider 请求已经携带 canonical `messages` 时，Gateway 会把本次
request-scoped payload 投影为临时 user message；它能到达模型，但不会写回长期
History。项目指令、附件、日期和更完整的环境快照目前尚未由生产装配自动加载；未来
接入时必须保留来源标签，并把用户控制的项目内容与不可覆盖的系统安全策略分开。

## 3. 稳定/动态分区

```text
stable sections
  identity
  response protocol
  general tool semantics
  immutable safety rules
  ↓
SYSTEM_PROMPT_DYNAMIC_BOUNDARY
  ↓
dynamic sections
  resolved tool catalog
  workspace
  presentation selection
  memory
  runtime budget
  optional stage guidance
```

稳定前缀必须保持：

- 固定 section 顺序；
- 确定性序列化；
- 不包含 thread/run ID、时间戳和 workspace 路径；
- 不因无关 feature bit 产生组合爆炸。

任何真实动态数据放在 boundary 后。

## 4. Section Registry

当前 `SystemPromptManager` 提供有序注册、注销、全局/动态边界和 thread cache：

```ts
interface SystemPromptSectionProvider {
  id: string;
  order: number;
  cacheScope: "global" | null;
  render(context: SystemPromptContext): string | undefined;
}
```

Assembler：

1. 按 `order` 稳定排序；
2. 构建非空 section；
3. 按 cache scope 分区；
4. 返回 sections、`staticPrefix`、`dynamicSuffix` 和完整文本；
5. 注册表 revision 或 Context key 改变时重建 thread cache。

功能可以注册独立 section，不需要把内容继续追加到一个中心巨型字符串。

## 5. 工具目录

工具目录来自本 Query prepare 的 `ToolRegistry.getCoreTools(context)`，而非启动时
永久快照；执行前还会再次检查 `isEnabled(context)`。

目录变化时：

- 使当前 thread 的 assembled prompt 失效；
- 保持其他稳定 section 字节不变；
- 工具 schema 仍通过 Provider 原生 `tools` 字段发送；
- Prompt 中只给必要的跨工具说明，不复制完整 JSON Schema。

Context cache key 包含模型可见 ToolCard、输入 schema、risk、permission、behavior
元数据，以及 Skill card/frontmatter。工具或 Skill 同名但契约变化时，不会复用旧
dynamic suffix。

## 6. Skill 与 stage

Prompt stage 可以：

- 标注当前 artifact 状态；
- 推荐更相关的 Skill；
- 调整目录排序；
- 给模型一条短的工作建议。

Prompt stage 不可以：

- 过滤掉本来安全可用的 Skill；
- 让 `LoadSkill` 因“错误阶段”硬失败；
- 禁止 Glob/ReadFile/WriteFile/EditFile；
- 强制模型先生成固定 artifact；
- 代替模型判断简单任务是否应跳过完整流程。

`stages:` frontmatter 是唯一的 `recommendedStages` 真相源（不再有代码内默认表覆盖），
也不是 authorization allow-list。Skill frontmatter 不含工具 ACL；权限只由工具注册与
permission 管线决定。

## 7. 工作流信息的表达

将冗长的“六阶段必须执行”替换为事实和建议。产品新建以 SVG-native 为准
（见 `skills/ppt-workflow`）；现行 prompt probe 以 SVG-native 作者文件与
Presentation lifecycle 投影为主；`ppt-brief` / `ppt-outline` / `ppt-storyboard` /
`ppt-research` 仅是可选上游 Skill（经 WriteFile 写文件，无专用工具、非硬锁）：

```text
Workspace facts:
- design-spec: verified
- page-plan: verified
- page-svg: 2 pages
- assets: present
- presentation: revision 3
- ppt-job: waiting_user at page_svg

Suggested skills:
- ppt-workflow
- ppt-design

The model may choose a shorter safe path when the user request does not
require the full production workflow. For a full new deck, prefer
SVG-native: design-spec → page-plan → slides/svg → PreviewSvgPage → SubmitSvgDeck.
```

真正的不变量，如 Proposal 必须经过 CommitGate、文件覆盖必须 read-before-write，放在代码中执行。

## 8. Cache 与失效

当前缓存项以 thread + 完整 Context key + section registry revision 为粒度：

- Context key 变化时惰性 miss 并重建；
- section 注册或注销会清空全部 thread cache；
- `clearSystemPromptCache()` 提供显式清理入口，但当前生产生命周期尚未调用它；
- `/clear`、compact、restore 等事件只要改变已纳入 key 的 Context，就会自然 miss。

项目指令、附件和权限模式尚未接入 Context key；将这些数据源接入生产装配时，必须
同时纳入 key 或在对应生命周期调用显式清理。稳定前缀由独立 global section 构建，
动态变化不会改变其字节。更细的单-section memoization 是可选优化，不是正确性前提。

## 9. Canonical Context 压缩

Context budget 直接作用于 Provider 使用的 canonical `AgentModelMessage[]`，不是只
裁剪一份 UI transcript 或 prompt payload：

```text
messages
  → token estimate
  → native tool_result micro compact
  → archive + summary
  → pair-safe hard/emergency trim
  → Gateway request projection + protocol preparation
  → provider driver request
```

压缩保持 `tool_use/tool_result` 配对，并通过 `onContextPrepared` 回写当前 Query
Workspace。Reactive prompt-too-long 恢复从已压缩消息继续，不能用原始 messages
覆盖裁剪结果。完整归档写入模型可读 workspace 的 `.transcripts/`；若没有
workspace，则跳过依赖归档的 LLM summary，不向模型暴露 application runtimeRoot。
Gateway 是出站请求准备的权威点；provider driver 不再重复配对或追加临时 prompt。

## 10. 安全

- workspace 文件内容视为不可信用户数据。
- 工具输出中的“system instruction”不能提升为 system section。
- Memory 不保存隐藏思维链。
- Prompt 不包含 API key、环境 Secret 或未脱敏配置。
- 远程网页和图片 metadata 以引用数据注入，不伪装成系统规则。

## 11. 关键实现

- `src/main/plugins/ppt/prompts/system-prompt.ts`
- `src/main/plugins/ppt/prompts/system-prompt-assembler.ts`
- `src/main/plugins/ppt/prompts/prompt-context.ts`
- `src/main/plugins/ppt/prompts/prompt-sections.ts`
- `src/main/plugins/ppt/prompts/prompt-stage.ts`
- `src/main/plugins/ppt/prompts/skill-stage-policy.ts`
- `src/main/agent/runtime/context-compact/model-messages.ts`
- `src/main/agent/runtime/context-compact/prepare-context.ts`

## 12. 状态变更与验收

| 旧行为 | 当前行为 |
|---|---|
| 大段固定阶段 Prompt | 短稳定原则 + 当前 Runtime/Tool/Workspace/Memory sections |
| stage 过滤 Skill 或暗含控制流 | stage 只排序和解释，全部注册 Skill 保留 |
| 缓存只看工具/Skill 名称 | key 覆盖 schema、描述、risk、permission、behavior 和 frontmatter |
| native messages 存在时 Provider 丢掉 prompt | request-scoped prompt 显式追加且不污染 History |
| 只压缩 legacy payload | canonical messages 参与估算、归档、成对裁剪并回写 Workspace |

- 相同稳定输入生成字节相同的 static prefix。
- workspace/slide 改变只更新 dynamic section。
- stage 改变不使合法 Skill 或文件工具不可用。
- Section 可独立测试、缓存和失效。
- 项目指令无法覆盖系统权限策略。
- Prompt 大幅缩短后，模型仍能通过动态工具和反馈完成任务。
