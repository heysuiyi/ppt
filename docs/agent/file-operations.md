# Glob、ReadFile、WriteFile 与 EditFile

> 文档类型：现行架构
> 最后核对：2026-07-30

## 1. 目标

Main Agent 与 teammate 已共享同一 `WorkspaceFileService`，本轮重构消除了以下旧问题：

- Main Agent 只能让 teammate 代写文件；
- 两套工具对路径、权限和写入安全有不同解释；
- Write/Edit 仅靠 Prompt 约束“先读文件”；
- Edit 静默替换第一个相似片段；
- 写入过程中留下半文件。

模型可见工具统一为：

- `Glob`
- `ReadFile`
- `WriteFile`
- `EditFile`

Main Agent 与 teammate 都只接受以上四个 PascalCase 工具名。旧的
`read_file/write_file/edit_file/glob` 不再注册为 alias；恢复后的新执行调用旧名称会
得到 unknown tool。两条运行时各自只保留薄适配器，工具名称、输入 schema、输出
schema、权限、描述和执行逻辑均来自唯一的 workspace 文件工具契约。

`WorkspaceFileService` 由 RunFactory 或 teammate runtime 按 thread/workspace 持有，
使 read receipt 能跨同一 Query 的连续工具调用生效。

workspace-level 项目文件管理页也复用该服务的底层安全和提交语义，但不伪装成模型
工具调用。Main 为每次打开文件签发隔离的 `editToken` 和读取时 SHA-256 version，
Renderer 保存时必须同时提交二者。

## 2. 路径解析

工具输入可以是 workspace-relative 或位于同一 workspace 的绝对路径。执行前：

1. 解析为规范化绝对路径；
2. 用 `path.relative` 和 `realpath` 检查目录穿越与 containment；
3. 拒绝 symlink/junction workspace root、路径组件和特殊文件；
4. 捕获 workspace 到父目录每一层的 `dev/ino`，在读写和 Glob 临界点重复验证；
5. workspace 外路径直接拒绝。

不能通过字符串前缀判断路径是否在 workspace。Glob 在每次 `readdir` 前后和递归
进入子目录时验证 inode/realpath，目录交换只会导致拒绝，不会返回外部文件名。

## 3. ReadFile 与读集

`ReadFile` 除内容外返回稳定收据：

```ts
interface FileReadReceipt {
  path: string;
  version: `sha256:${string}`;
  mtimeMs: number;
  size: number;
  encoding: "utf8";
  newline: "lf" | "crlf" | "mixed" | "none";
}
```

模型读取采用有界窗口。首次调用默认从 `offset=0` 开始；返回 `hasMore=true` 时，
下一次调用必须原样传入 `nextOffset` 和首次返回的 `version`（作为
`expected_version`），直到 `hasMore=false`。窗口元数据为：

```ts
interface FileReadWindow {
  startOffset: number;
  endOffset: number;
  totalCharacters: number;
  hasMore: boolean;
  nextOffset?: number;
  content: string;
}
```

Service 在当前 thread/workspace 实例中记录同一版本的已读区间。只有区间覆盖完整
文件后才签发可用于 Write/Edit 的 receipt；内部预览、锁校验和诊断读取使用
`inspect`，不会授予写权限。`expected_version` 不要求模型计算 hash，但只能匹配首次
窗口返回的版本，不能代替真实的完整读取。

项目文件编辑的 token 绑定 session、workspace root、规范化相对路径和独立
`WorkspaceFileService` 读取 scope。另一位调用者读取同一文件不会刷新这份 receipt；
token 缺失、过期、跨 session/path 使用或 `expectedVersion` 与 receipt 不一致时拒绝
保存。打开结果还包含 Main 计算的 `editable/readOnlyReason`；保存入口不会信任
Renderer 回传的可编辑状态，而会重新解析 artifact policy。

Read 行为：

- 只读取普通 UTF-8 文本；非法 UTF-8 返回 `INVALID_UTF8`；
- 通过 handle 前后 stat 与路径 lstat 验证同一 inode 和稳定大小/时间；
- 目录、FIFO/device、symlink/junction 返回 `UNSAFE_FILE_TYPE`；
- 单次最多返回 4000 个 UTF-16 单元，边界不会拆分 Unicode 代理对；
- 文件在分页期间变化时返回 `STALE_FILE`，调用方必须从 `offset=0` 重新读取；
- `.task_outputs/tool-results/` 中的持久化大结果也通过同一窗口协议恢复，不能把预览
  或持久化包装文件的首段当作完整事实；
- 如发现未完成的受保护替换，先依据 durable manifest 恢复或显式报
  `uncertain`，再建立 receipt。

## 4. Read-before-write

### 覆盖已有文件

WriteFile 覆盖已有文件前必须存在当前 service 的有效 read receipt。

若文件在读取后发生变化：

工具返回 `STALE_FILE`，不覆盖新内容，并要求模型重新 ReadFile 后合并。

### 创建新文件

新文件无需先读，但必须在写入临界区再次确认目标仍不存在。若另一个进程已创建，返回冲突而不是覆盖。

## 5. WriteFile

WriteFile 接收完整目标内容。写入流程：

```text
resolve + authorize
  → inspect current file
  → verify read receipt / creation precondition
  → capture directory identities
  → write temp in canonical workspace root
  → flush temp
  → persist replacement manifest
  → displace and verify the exact old inode
  → hard-link the prepared inode into place
  → verify path identities and committed content
  → clean backup/manifest and flush directories where supported
  → return the commit-verified receipt
```

`WriteFile` 创建新文件时自动创建父目录，不再暴露 `ensure_dir`。teammate 的 `bash`
不启动 shell，只执行 fail-closed 的只读 direct-exec 诊断白名单；`mkdir`、重定向、
管道、解释器代码和任意可执行文件都会在启动前拒绝。

Windows 和 guarded replacement 使用带 old/new fingerprint 的 durable manifest 与
唯一 backup。恢复只在 inode/hash 能证明 old/new 身份时自动完成；未知 target 保留
manifest/backup 并上报 `uncertain`，不会静默删除原文件。

Renderer 只有 `openProjectFile → saveProjectFile` 编辑协议。保存使用打开文件时返回的
隔离 `editToken` 与 `expectedVersion`，相同内容直接返回无变更；stale 冲突保留当前
草稿，并要求重新读取。Renderer 不能创建文件，只能编辑已经存在且已注册为可编辑
文本 artifact 的文件；`deck`、`history`、未知路径和缺失目标会在 Main 拒绝。

storyboard、deck、history 等领域内部写入直接调用各自明确的可信写入 API，并继续
执行状态持久化和 stale 传播。它们不经过 Renderer 编辑协议，也不对 Renderer 暴露
无 token 的覆盖入口。

## 6. EditFile

EditFile 是确定性的精确编辑：

```ts
{
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}
```

规则：

- 文件必须已 ReadFile；
- `oldString` 不能为空；
- 默认必须恰好匹配一次；
- 0 次匹配返回 `OLD_STRING_NOT_FOUND`；
- 多次匹配返回 `AMBIGUOUS_EDIT`，要求扩大上下文或显式 `replaceAll`；
- `oldString === newString` 返回 `INVALID_EDIT`；
- 在写临界区重新读取并验证 hash、mtime/ctime、size、dev/ino；
- 使用与 WriteFile 相同的原子提交；
- 未触及文本的换行保持原样；
- 返回 replacement 数和新 receipt。

不做模糊匹配，不自行“猜”模型想改哪一段。

## 7. 临界区与并发

同一进程先按规范化路径排队；随后同一 target 的跨进程文件锁覆盖
`recovery → stable read / guarded replace` 整个临界区。compare-and-commit 仍会把
被 displacement 的真实 inode 与 receipt 比较，再验证安装后的 inode、内容和每层
目录 identity；锁不是省略 stale 校验的理由。

```text
acquire(process queue + cross-process target lock)
  → recover or reject durable manifest
  → re-read
  → compare receipt
  → guarded compare-and-commit
  → record new receipt
release
```

同一 Query 中连续编辑成功后，read-set 自动更新为最新 receipt，模型不必为了工具刚刚完成的确定性写入再读一次。

项目文件管理页成功保存后可沿用同一 token 和新 version 继续编辑；
compare-and-commit 进入后失败会使该编辑 scope 失效，页面必须重新打开文件，而不能
用旧凭证盲目重试。只读策略或内容大小等执行前拒绝不消费 token。

文件内容原子提交成功后，若会话状态持久化或 workspace metadata 同步失败，Main
返回 `postCommitWarnings`，页面明确显示“内容已保存但状态同步失败”，不会把已经
落盘的内容误报成未保存。

## 8. 写后反馈

当前成功结果包含：

- normalized path
- `created`
- `characterCount`
- Edit 的 `replacements`
- 新 `version/mtimeMs/size/encoding/newline` receipt

Main 与 teammate 使用同一输出 schema 校验和错误分类。`WorkspaceFileError` 只用于
执行前失败或已经确认完整回滚的失败，因此两条执行路径都返回错误码并标记
`sideEffects=none`。回滚、恢复或清理无法证明时抛普通/
`AtomicWriteConflictError` 并标记 `uncertain`；不能把不确定副作用伪装成安全重试。

当前文件工具尚不返回结构化 diff、增删行或 file history snapshot；Presentation
artifact schema 由消费方在使用前验证，不由通用 WriteFile 自动推导 `ready`。

项目文件管理页的 diff 由应用层基于当前文件和编辑草稿生成；这不改变模型工具结果
协议，也不构成 file history 或 immutable Artifact Revision。只有已注册、可编辑
artifact 下的文本文件能保存；`deck`、`history` 和未知 artifact 文件保持只读，
防止普通文件编辑绕过 Presentation/CommandBus 或导出历史的事实源。

## 9. 权限

| 操作 | workspace 内 | workspace 外 |
|---|---|---|
| ReadFile / Glob | permission profile + path guard | deny |
| 新建文件 | workspace-write + guarded create | deny |
| 覆盖/Edit | workspace-write + read receipt + guarded replace | deny |
| 项目文件页读取 | session + path guard；返回 artifact edit policy | deny |
| 项目文件页保存 | 已注册可编辑文本 artifact + session-bound token + version CAS | deny；deck/history/未知 artifact 同样 deny |
| teammate diagnostic | direct-exec allowlist | 不接受自定义 cwd/path root |

权限通过代码检查。Prompt 中“只能写 workspace”只是解释，不是安全边界。

## 10. 关键实现

唯一工具契约与共享服务：

```text
src/main/agent/tools/files/
├─ workspace-file-tool-contract.ts
└─ workspace-file-service.ts
```

Main ToolDefinition 适配器位于 `src/main/agent/tools/core/workspace-files.ts`；
teammate 适配器位于 `src/main/agent/subagent/workspace-tools.ts`。teammate 仍有独立
编排器和较小工具池，但文件工具契约和执行语义完全一致。

项目文件管理应用协议位于：

- `src/main/project/project-file-service.ts`
- `src/shared/ipc.ts`
- `src/preload/index.ts`
- `src/renderer/src/app/WorkspaceView.tsx`（工作区内的文件页面分支）
- `src/renderer/src/app/project/useProjectFiles.ts`
- `src/renderer/src/components/ProjectFilesPage.tsx`

底层原子替换复用并增强：

- `src/main/agent/persistence/atomic-json-file.ts`

Main 和 teammate 的 ToolDefinition 都调用同一底层服务。

## 11. 测试矩阵

- 新建、覆盖、唯一 Edit、replaceAll。
- 未读覆盖、读取后外部修改、并发创建。
- 0/多匹配和 no-op。
- CRLF/LF、Unicode、非法 UTF-8、特殊文件。
- workspace escape、内部 symlink、链接 root、父目录交换。
- same-content inode replacement、并发创建、commit-boundary 外部 writer。
- manifest crash recovery、未知 target 保留 backup、成功后清理。
- active transaction 不被另一个 reader/recovery 当成 crash，JSON fallback 不覆盖等待中的新 writer。
- Bash 重定向/任意解释器拒绝与只读 direct-exec。
- Main/teammate 四个文件工具名称、schema、输出和权限完全一致；旧名称、
  `ensure_dir` 与 `bash mkdir` 都不可调用。
- 项目文件 list/open/diff/save、token 跨 session/path 拒绝及过期处理。
- Store 自动保存严格执行 open/save、连续保存使用最新 receipt、冲突保留草稿。
- 补丁接受在保存前核对 `contentBefore`；缺失或变化的基线拒绝应用。
- Renderer 拒绝创建新文件、只读 artifact 和缺失目标。
- 页面读取后被 Agent/外部 writer 修改时，旧 SHA-256 version 保存失败。
- 文本编辑大小上限、deck/history/未知 artifact 只读，以及删除、重命名和二进制编辑不进入该协议。

核心回归位于 `tests/workspace-file-service.test.ts` 和
`tests/tool-execution-pipeline.test.ts`；项目文件应用链还覆盖
`tests/project-file-editor-safety.test.ts`。

## 12. 状态变更

| 旧行为 | 当前行为 |
|---|---|
| Main Agent 依赖 teammate 写文件 | Main/teammate 都解析同一文件能力并共享 receipt service |
| “先读后写”主要靠 Prompt | `READ_REQUIRED`、`expected_version` 和完整 inode snapshot 由代码执行 |
| stale 检查后再无条件 rename | displacement 后比较真实旧 inode，再安装并验证 prepared inode |
| Windows `.old` 文件靠存在性猜测恢复 | durable manifest 记录 old/new fingerprint；歧义时保留证据并报 `uncertain` |
| Bash 只设置 cwd，仍可重定向越界 | 无 shell 的只读 direct-exec allowlist；文件 mutation 走结构化工具 |
| 文件存在即可参与工作流 | 通用写入不推导 artifact ready；消费方必须解析/验证 |
| teammate 维护 snake_case 文件工具 | Main/teammate 共享唯一 PascalCase 文件工具契约与错误语义 |
| Renderer 曾有独立 artifact writer 覆盖或创建 | 仅可 open/save 已注册可编辑文本 artifact，使用隔离 token + SHA-256 CAS |
