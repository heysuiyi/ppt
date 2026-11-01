import type { Readable, Writable } from "node:stream";
import type { AgentRunHandle, AgentRunResult } from "@agent-harness/core/agent-contract";
import type {
  InteractionRequest,
  InteractionResponse,
  RunIdentity,
} from "@agent-harness/core/protocol-values";
import {
  LOCAL_COMMANDS,
  parseSubmittedText,
  TERMINAL_HELP,
  type TerminalCommand,
} from "../commands/terminal-command.js";
import type { TerminalHost, TerminalSetupIO, TerminalToolsMode } from "../host/host-contract.js";
import { createComposer } from "./composer.js";
import type { Composer, NodeTerminal, Selector, TerminalKeyEvent } from "./input-contract.js";
import { createTerminalRenderer } from "./interactive-renderer.js";
import { createNodeTerminal } from "./node-terminal.js";
import { createPreviewBuffer } from "./preview-buffer.js";
import type { TerminalRenderer, TerminalSelectorView, TerminalView } from "./renderer-contract.js";
import { createSelector } from "./selector.js";
import type {
  TerminalExitDecision,
  TerminalFailureStage,
  TerminalPhase,
  TerminalModelItem,
  TerminalSelectionItem,
} from "./terminal-contract.js";
import {
  interactionReference,
  projectTerminalEvent,
  projectTerminalResult,
  terminalError,
} from "./terminal-projection.js";

export interface TerminalControllerOptions {
  readonly command: TerminalCommand;
  readonly host: TerminalHost;
  readonly input: Readable;
  readonly output: Writable;
  readonly error: Writable;
  readonly writeOutput: (text: string) => Promise<void>;
  readonly writeError: (text: string) => Promise<void>;
}

interface ModelNavigation {
  readonly models: readonly TerminalModelItem[];
  readonly groups: Selector;
  readonly action: TerminalSelectionItem;
  pane: "groups" | "models";
}

type Focus =
  | { readonly type: "composer" }
  | {
      readonly type: "text";
      readonly prompt: string;
      readonly secret: boolean;
      readonly editor: Composer;
      readonly resolve: (value: string | undefined) => void;
    }
  | {
      readonly type: "selector";
      readonly title: string;
      selector: Selector;
      sourceItems: readonly TerminalSelectionItem[];
      readonly navigation?: ModelNavigation;
      typed: string;
      readonly resolve: (value: string | undefined) => void;
    };

const failureOrder: readonly TerminalFailureStage[] = [
  "persistence",
  "close",
  "output",
  "completion",
  "observation",
  "protocol",
  "input",
  "activation",
  "configuration",
];

/** 一个控制器拥有输入、观察消费、当前句柄及退出；等待不保留 Core Run 调用栈。 */
export async function runTerminalController(options: TerminalControllerOptions): Promise<number> {
  const { command, host } = options;
  let phase: TerminalPhase = "starting";
  let generation = 0;
  let focus: Focus = { type: "composer" };
  const composer = createComposer();
  let notification: string | undefined;
  let activity: string | undefined;
  let modelStatus: string | undefined;
  let pendingInteraction: InteractionRequest | undefined;
  let active: AgentRunHandle | undefined;
  let lastResult: AgentRunResult | undefined;
  let lastIdentity: RunIdentity | undefined;
  let runTask: Promise<void> | undefined;
  let uiTask: Promise<void> | undefined;
  let completion: Selector | undefined;
  let finalCode = 1;
  let ready = false;
  let stopping = false;
  let eof = false;
  let terminated = false;
  let cancelRequested = false;
  let userCancelledQuery = false;
  let settlingCancellation = false;
  let brokenPipe = false;
  let outputFailed = false;
  let failure: TerminalFailureStage | undefined;
  let pasteLines: string[] | undefined;
  let renderer: TerminalRenderer;
  let terminal: NodeTerminal;
  let events = Promise.resolve();
  const { promise: finished, resolve: finish } = Promise.withResolvers<void>();
  const inputIsTTY = "isTTY" in options.input && options.input.isTTY === true;
  let oneShot =
    command.prompt !== undefined ||
    command.queryId !== undefined ||
    command.print ||
    command.output === "jsonl" ||
    !inputIsTTY;

  function switchFocus(next: Focus): void {
    generation++;
    terminal.setGeneration(generation);
    focus = next;
  }

  function resolveFocus(value: string | undefined): void {
    const current = focus;
    switchFocus({ type: "composer" });
    if (current.type !== "composer") current.resolve(value);
  }

  function noteFailure(stage: TerminalFailureStage): void {
    if (failure === undefined || failureOrder.indexOf(stage) < failureOrder.indexOf(failure))
      failure = stage;
  }

  function isPipeError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPIPE";
  }

  async function output(action: () => Promise<void>): Promise<void> {
    if (outputFailed) return;
    try {
      await action();
    } catch (error) {
      outputFailed = true;
      if (isPipeError(error)) brokenPipe = true;
      else noteFailure("output");
      requestStop(true);
    }
  }

  async function report(error: unknown, stage: TerminalFailureStage): Promise<void> {
    noteFailure(stage);
    await output(() =>
      renderer.record({
        version: 1,
        type: "error",
        stage,
        error: terminalError(error),
        outcomeUncertain: stage === "completion" || stage === "persistence" || stage === "close",
        ...(lastIdentity ? { identity: lastIdentity } : {}),
      }),
    );
  }

  function requestStop(interruptHost = false): void {
    stopping = true;
    resolveFocus(undefined);
    if (interruptHost) void host.close().catch((error: unknown) => report(error, "close"));
    if (!runTask) finish();
  }

  async function refresh(): Promise<void> {
    if (outputFailed || stopping || phase === "closing") return;
    const draft = focus.type === "text" && !focus.secret ? focus.editor.draft : composer.draft;
    const selector: TerminalSelectorView | undefined =
      focus.type === "selector"
        ? {
            title: focus.title,
            query: focus.typed,
            items:
              !focus.navigation && terminal.mode === "plain" && /^\d+$/.test(focus.typed)
                ? focus.sourceItems
                : focus.selector.items,
            selectedId: focus.selector.selectedId,
            ...(focus.navigation
              ? {
                  navigation: {
                    groups: focus.navigation.groups.items,
                    selectedGroupId: focus.navigation.groups.selectedId!,
                    pane: focus.navigation.pane,
                    action: focus.navigation.action,
                  },
                }
              : {}),
          }
        : completion
          ? {
              title: "命令补全 · 接受后仍需再次 Enter",
              query: "",
              items: completion.items,
              selectedId: completion.selectedId,
            }
          : undefined;
    const view: TerminalView = {
      phase,
      ...(activity ? { activity } : {}),
      composer: {
        draft: focus.type === "text" && focus.secret ? { text: "", cursor: 0 } : draft,
        editable: true,
        submission:
          phase === "idle" && ready && focus.type === "composer" && !uiTask
            ? { enabled: true }
            : {
                enabled: false,
                reason:
                  phase === "starting" ? "not-ready" : phase === "waiting" ? "interaction" : "busy",
              },
      },
      ...(ready
        ? {
            context: {
              workspace: host.context.workspaceRoot,
              threadId: host.context.threadId,
              model: host.context.model.label,
              ...((modelStatus ?? host.context.model.availability?.reason)
                ? { modelStatus: modelStatus ?? host.context.model.availability?.reason }
                : {}),
              capabilities: host.context.toolsMode,
            },
          }
        : {}),
      ...(selector ? { selector } : {}),
      ...(pendingInteraction
        ? {
            interaction: {
              reference: interactionReference(pendingInteraction),
              display: host.describeInteraction(pendingInteraction),
            },
          }
        : {}),
      ...(focus.type === "text" ? { prompt: { text: focus.prompt, secret: focus.secret } } : {}),
      ...(notification ? { notification } : {}),
    };
    await output(() => renderer.view(view));
  }

  async function askText(prompt: string, secret = false): Promise<string | undefined> {
    if (stopping || eof) return undefined;
    if (secret && !terminal.secretAvailable) throw new Error("Secure terminal input unavailable");
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    switchFocus({ type: "text", prompt, secret, editor: createComposer(), resolve });
    await refresh();
    return promise;
  }

  async function askSelection(
    title: string,
    items: readonly TerminalSelectionItem[],
    selectedId: string | null = null,
  ): Promise<string | undefined> {
    if (stopping || eof) return undefined;
    if (!items.length) {
      await output(() => renderer.message("没有可用选项。"));
      return undefined;
    }
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    switchFocus({
      type: "selector",
      title,
      selector: createSelector(items, selectedId),
      sourceItems: items,
      typed: "",
      resolve,
    });
    await refresh();
    return promise;
  }

  function modelGroup(model: TerminalModelItem): string {
    return model.vendor ? `vendor:${model.vendor.id}` : "legacy";
  }

  function filterModels(current: Extract<Focus, { type: "selector" }>): void {
    const navigation = current.navigation!;
    const group = navigation.groups.selectedId;
    const items = navigation.models
      .filter((model) => group === "all" || modelGroup(model) === group)
      .map((model) => ({
        id: model.id,
        label: `${model.modelName ?? model.label}${model.id === host.context.model.id ? " · 当前" : ""}${model.availability?.state === "unavailable" ? " · 不可用" : ""}`,
        description: `${model.vendor?.label ?? "已配置连接"} · ${model.availability?.reason ?? "本地状态未提供"}`,
      }));
    current.sourceItems = [...items, navigation.action];
    const filtered = createSelector(items);
    // Plain 数字是当前组的稳定序号，不作为搜索条件；配置动作永不被搜索隐藏。
    filtered.search(terminal.mode === "plain" && /^\d+$/.test(current.typed) ? "" : current.typed);
    current.selector = createSelector(
      [...filtered.items, navigation.action],
      current.selector.selectedId,
    );
  }

  async function askModel(models: readonly TerminalModelItem[]): Promise<string | undefined> {
    if (stopping || eof) return undefined;
    const groups: TerminalSelectionItem[] = [{ id: "all", label: "All · 全部连接" }];
    for (const model of models) {
      const id = modelGroup(model);
      if (!groups.some((group) => group.id === id))
        groups.push({ id, label: model.vendor?.label ?? "已配置连接" });
    }
    let actionId = "__configure_connection";
    while (models.some((model) => model.id === actionId)) actionId += "_";
    const action = { id: actionId, label: "+ 添加/配置连接" };
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    const next: Extract<Focus, { type: "selector" }> = {
      type: "selector",
      title: "选择已配置模型 · 仅检查本地配置",
      selector: createSelector([], host.context.model.id),
      sourceItems: [],
      typed: "",
      navigation: {
        models,
        groups: createSelector(groups, "all"),
        pane: "models",
        action,
      },
      resolve: (value) => resolve(value === actionId ? undefined : value),
    };
    filterModels(next);
    next.selector = createSelector(next.selector.items, host.context.model.id);
    // 配置动作与退出必须区分；模型 ID 本身不承担动作协议。
    next.resolve = resolve;
    switchFocus(next);
    await refresh();
    const selected = await promise;
    return selected === actionId ? await configureConnection() : selected;
  }

  async function loadModels(): Promise<readonly TerminalModelItem[] | undefined> {
    return withActivity("正在加载模型目录", async () => {
      try {
        return await host.models();
      } catch (error) {
        notification = `模型目录加载失败：${terminalError(error).message}`;
        await output(() => renderer.message(notification!));
        return undefined;
      }
    });
  }

  async function configureConnection(): Promise<string | undefined> {
    let selected: string | undefined;
    try {
      selected = await withActivity("正在配置连接", () => host.configureModel(setup));
    } catch (error) {
      if (terminalError(error).code !== "HOST_CONFIGURATION_REJECTED") throw error;
      notification = `连接配置未完成：${terminalError(error).message}；当前会话保持不变。`;
      await output(() => renderer.message(notification!));
      return undefined;
    }
    if (!selected) {
      notification = "已取消连接配置；当前会话与草稿保持不变。";
      return undefined;
    }
    notification = "连接与 CLI 默认模型已保存；当前会话未切换，须另确认新建绑定。";
    await output(() => renderer.message(notification!));
    return selected;
  }

  async function chooseModel(connect: boolean): Promise<void> {
    let models = await loadModels();
    if (!models && !connect) {
      // 即便目录读取失败，仍保留进入真实配置向导的入口。
      models = [];
    }
    const currentId = host.context.model.id;
    modelStatus = models?.find((item) => item.id === currentId)?.availability?.reason;
    const selectedId = connect ? await configureConnection() : await askModel(models ?? []);
    if (!selectedId) {
      notification ??= "已取消模型选择；当前模型与会话保持不变。";
      return;
    }
    // 向导可能新增连接或更新既有模型；确认绑定前重新读取权威本地目录。
    models = await loadModels();
    const selected = models?.find((item) => item.id === selectedId);
    if (!selected) {
      notification = "未找到所选模型；当前会话保持不变。已保存的连接配置不会删除。";
      return;
    }
    if (selected.id === currentId) {
      notification = "当前模型已选中；未创建新会话。";
      return;
    }
    if (selected.availability?.state === "unavailable") {
      notification = `模型不可用：${selected.availability.reason}`;
      await output(() => renderer.message(notification!));
      return;
    }
    if (!(await confirmSwitch(`模型 ${selected.label}`))) {
      notification = "已取消模型切换；当前模型、会话与草稿保持不变；已保存的连接/默认配置保留。";
      return;
    }
    await withActivity(`正在切换模型：${selected.label}`, () =>
      host.newSession({ modelId: selected.id }),
    );
    modelStatus = selected.availability?.reason;
    await sessionRecord();
    notification = `已切换模型：${host.context.model.label}；新绑定会话 ${host.context.threadId}`;
    await output(() => renderer.message(notification!));
  }

  const setup: TerminalSetupIO = {
    text: (prompt) => askText(prompt),
    secret: (prompt) => askText(prompt, true),
    select: askSelection,
    notify: (text) => output(() => renderer.message(text)),
  };

  async function sessionRecord(): Promise<void> {
    const context = host.context;
    await output(() =>
      renderer.record({
        version: 1,
        type: "session",
        threadId: context.threadId,
        model: { id: context.model.id, label: context.model.label },
        capabilities:
          context.toolsMode === "none" ? [] : [{ id: context.toolsMode, label: context.toolsMode }],
      }),
    );
  }

  async function answerWaiting(
    request: InteractionRequest,
  ): Promise<InteractionResponse | undefined> {
    pendingInteraction = request;
    while (!stopping && !eof) {
      if (cancelRequested) return { type: "cancel", interactionId: request.id };
      const display = host.describeInteraction(request);
      if (terminal.mode === "plain") {
        const labels =
          display.support === "supported"
            ? display.choices.map((item) => item.id).join(" / ")
            : "不支持回答";
        const text = await askText(
          `等待 ${request.id}：${labels}；输入 choiceId interactionId，cancel interactionId 取消，exit 保留退出。`,
        );
        if (cancelRequested) return { type: "cancel", interactionId: request.id };
        if (text === undefined) {
          if (stopping || eof) return undefined;
          continue;
        }
        if (text.trim() === "exit") {
          requestStop();
          return undefined;
        }
        const split = text.trim().split(/\s+/);
        if (split.length !== 2 || split[1] !== request.id) {
          notification = "必须输入当前完整 interactionId。";
          await refresh();
          continue;
        }
        if (split[0] === "cancel") return { type: "cancel", interactionId: request.id };
        if (display.support !== "supported") {
          notification = "不支持此交互格式；只能取消或保留等待。";
          continue;
        }
        try {
          return host.answerInteraction(request, split[0]!, split[1]);
        } catch {
          notification = "交互选项或确认身份无效；等待保持。";
          continue;
        }
      }
      const items: TerminalSelectionItem[] =
        display.support === "supported"
          ? display.choices.map((choice) => ({ id: choice.id, label: choice.label }))
          : [];
      items.push({ id: "__cancel", label: "取消请求" }, { id: "__keep", label: "保留等待并退出" });
      const selected = await askSelection(`等待回答 · ${request.id}`, items);
      if (cancelRequested) return { type: "cancel", interactionId: request.id };
      if (selected === "__keep") {
        requestStop();
        return undefined;
      }
      if (selected === "__cancel") return { type: "cancel", interactionId: request.id };
      if (selected === undefined) {
        if (eof || stopping) return undefined;
        notification = "等待保持，未批准或拒绝。";
        continue;
      }
      if (display.support !== "supported") continue;
      const confirmation =
        display.confirmation === "interaction-id"
          ? await askText(`请输入完整交互 ID：${request.id}`)
          : undefined;
      if (cancelRequested) return { type: "cancel", interactionId: request.id };
      if (stopping || eof) return undefined;
      try {
        return host.answerInteraction(request, selected, confirmation);
      } catch {
        notification = "交互选项或确认身份无效；等待保持。";
      }
    }
    return undefined;
  }

  async function executeQuery(initial: Promise<AgentRunHandle>): Promise<void> {
    phase = "running";
    cancelRequested = false;
    userCancelledQuery = false;
    await refresh();
    let handle = await initial;
    for (;;) {
      active = handle;
      lastIdentity = handle.identity;
      lastResult = undefined;
      if (cancelRequested && !settlingCancellation) handle.cancel("用户取消");
      const preview = createPreviewBuffer(handle.identity);
      const observing = (async () => {
        try {
          for await (const event of handle.events) {
            const expected = handle.identity;
            const actual = event.identity;
            if (
              actual.agentId !== expected.agentId ||
              actual.threadId !== expected.threadId ||
              actual.queryId !== expected.queryId ||
              actual.runId !== expected.runId
            )
              continue;
            const record = projectTerminalEvent(event, (request) =>
              host.describeInteraction(request),
            );
            if (record) await output(() => renderer.record(record));
            if (event.type === "model.delta")
              await output(() => renderer.preview(preview.update(event)));
          }
        } catch (error) {
          await report(error, "observation");
        }
      })();
      let result: AgentRunResult;
      try {
        result = await handle.completed;
      } finally {
        await observing;
        active = undefined;
        preview.clear();
        await output(() => renderer.preview([]));
      }
      settlingCancellation = false;
      phase = "settling";
      lastResult = result;
      for (const record of projectTerminalResult(result, (request) =>
        host.describeInteraction(request),
      ))
        await output(() => renderer.record(record));
      if (result.status === "failed") {
        noteFailure("completion");
        requestStop();
        break;
      }
      if (result.status !== "waiting") break;
      phase = "waiting";
      pendingInteraction = result.interaction;
      await refresh();
      // A cancelled old Run may still settle waiting. Consume this durable interaction
      // with a fresh activation; never reuse the old aborted signal.
      const response = cancelRequested
        ? { type: "cancel" as const, interactionId: result.interaction.id }
        : terminal.mode === "headless" ||
            command.print ||
            command.output === "jsonl" ||
            command.prompt !== undefined ||
            stopping ||
            eof
          ? undefined
          : await answerWaiting(result.interaction);
      if (!response) break;
      if (response.type === "cancel") userCancelledQuery = true;
      settlingCancellation = response.type === "cancel";
      phase = "submitting";
      pendingInteraction = undefined;
      switchFocus({ type: "composer" });
      await refresh();
      if (settlingCancellation) cancelRequested = false;
      handle = await host.resume(result.identity.queryId, response);
      phase = "running";
    }
    pendingInteraction = lastResult?.status === "waiting" ? lastResult.interaction : undefined;
    if (stopping || oneShot || eof || lastResult?.status === "waiting") {
      stopping = true;
      finish();
    }
  }

  function launchQuery(start: () => Promise<AgentRunHandle>): void {
    if (runTask || stopping) return;
    const task = executeQuery(start())
      .catch(async (error: unknown) => {
        await report(error, "completion");
        requestStop();
      })
      .finally(() => {
        runTask = undefined;
        if (stopping || eof) finish();
        else {
          phase = "idle";
          cancelRequested = false;
          switchFocus({ type: "composer" });
          void refresh();
        }
      });
    runTask = task;
  }

  function launchUI(action: () => Promise<void>): void {
    if (uiTask || stopping) return;
    uiTask = Promise.resolve()
      .then(action)
      .catch(async (error: unknown) => {
        const publicError = terminalError(error);
        if (publicError.code === "HOST_SWITCH_REJECTED") {
          notification = publicError.message;
          await output(() => renderer.message(publicError.message));
        } else {
          await report(error, "activation");
          requestStop();
        }
      })
      .finally(() => {
        uiTask = undefined;
        activity = undefined;
        void refresh();
      });
  }

  async function withActivity<T>(text: string, operation: () => Promise<T>): Promise<T> {
    activity = text;
    notification = undefined;
    await refresh();
    try {
      return await operation();
    } finally {
      activity = undefined;
      await refresh();
    }
  }

  async function confirmSwitch(target = "新会话"): Promise<boolean> {
    const answer = await askText(
      `目标：${target}\n将新建绑定会话；保留草稿，不迁移旧 Query。\n输入 yes 确认：`,
    );
    return answer?.trim() === "yes";
  }

  async function localCommand(name: string): Promise<void> {
    switch (name) {
      case "help":
      case "hotkeys":
        await output(() => renderer.message(TERMINAL_HELP));
        break;
      case "status":
        await output(() =>
          renderer.message(
            `工作区 ${host.context.workspaceRoot}\n会话 ${host.context.threadId}\n模型 ${host.context.model.label}\n能力 ${host.context.toolsMode}\n数据 ${host.context.dataRoot}\n状态 ${phase}`,
          ),
        );
        break;
      case "exit":
        requestStop();
        break;
      case "paste":
        pasteLines = [];
        notification = "多行输入：独立行 /end 发送，//end 插入 /end；EOF 不发送。";
        break;
      case "new":
        if (await confirmSwitch()) {
          await withActivity("正在创建绑定会话", () => host.newSession());
          modelStatus = undefined;
          await sessionRecord();
        }
        break;
      case "model":
      case "connect":
        await chooseModel(name === "connect");
        break;
      case "tools": {
        const modes: readonly TerminalSelectionItem[] = [
          { id: "none", label: "无业务插件" },
          { id: "read-only", label: "只读文件" },
          { id: "read-write", label: "读写文件（写入需审批）" },
        ];
        const selected = await askSelection("选择能力模式", modes);
        if (selected && (await confirmSwitch())) {
          await withActivity("正在切换能力与绑定会话", () =>
            host.newSession({ toolsMode: selected as TerminalToolsMode }),
          );
          modelStatus = undefined;
          await sessionRecord();
        }
        break;
      }
      case "resume": {
        const sessions = await withActivity("正在加载会话目录", () => host.sessions());
        const selected = await askSelection("当前工作区会话", sessions);
        if (selected && (await confirmSwitch())) {
          const session = await withActivity("正在恢复绑定会话", () =>
            host.selectSession(selected),
          );
          modelStatus = undefined;
          await output(() => renderer.history(session.history));
          await sessionRecord();
          if (session.unfinished) launchQuery(() => host.resume(session.unfinished!.queryId));
        }
        break;
      }
      case "tools-output": {
        const selected = await askSelection("安全工具输出", renderer.tools());
        if (selected) await output(() => renderer.selectTool(selected));
        break;
      }
    }
    await refresh();
  }

  async function dispatch(event: TerminalKeyEvent): Promise<void> {
    if (event.generation !== generation || stopping) return;
    const key = event.key;
    if (key.action === "insert") notification = undefined;
    if (
      key.action === "interrupt" &&
      (phase === "running" ||
        phase === "waiting" ||
        phase === "submitting" ||
        phase === "cancelling")
    ) {
      if (settlingCancellation) return;
      cancelRequested = true;
      if (pendingInteraction) resolveFocus(undefined);
      else {
        phase = "cancelling";
        active?.cancel("用户取消");
      }
      await refresh();
      return;
    }
    if (focus.type === "text") {
      if (key.action === "submit") {
        const value = focus.editor.draft.text;
        focus.editor.clear();
        resolveFocus(value);
      } else if (key.action === "escape" || key.action === "interrupt" || key.action === "eof") {
        focus.editor.clear();
        if (key.action === "eof") {
          eof = true;
          requestStop();
        } else resolveFocus(undefined);
      } else focus.editor.edit(key);
      await refresh();
      return;
    }
    if (focus.type === "selector") {
      if (key.action === "eof" && phase === "waiting") {
        eof = true;
        requestStop();
      } else if (key.action === "escape" || key.action === "interrupt" || key.action === "eof")
        resolveFocus(undefined);
      else if (key.action === "up") focus.selector.move(-1);
      else if (key.action === "down") focus.selector.move(1);
      else if (key.action === "insert" && !key.text.includes("\n")) {
        focus.typed += key.text;
        focus.selector.search(focus.typed);
      } else if (key.action === "backspace") {
        focus.typed = Array.from(focus.typed).slice(0, -1).join("");
        focus.selector.search(focus.typed);
      } else if (key.action === "submit" || key.action === "tab") {
        const query = focus.typed.trim();
        const index = /^\d+$/.test(query) ? Number(query) - 1 : -1;
        const selected =
          index >= 0
            ? focus.sourceItems[index]?.id
            : (focus.selector.accept() ?? focus.sourceItems.find((item) => item.id === query)?.id);
        if (selected) resolveFocus(selected);
      }
      await refresh();
      return;
    }
    if (key.action === "toggle-tool") {
      await output(() => renderer.toggleTool());
      return;
    }
    if (key.action === "select-model") {
      if (phase === "idle" && !uiTask) launchUI(() => localCommand("model"));
      else notification = "执行或会话切换中不能切换模型。";
      await refresh();
      return;
    }
    if (key.action === "escape") {
      if (completion) {
        completion = undefined;
        await refresh();
        return;
      }
      if (phase === "running") {
        cancelRequested = true;
        phase = "cancelling";
        active?.cancel("用户取消");
      }
      await refresh();
      return;
    }
    if (key.action === "interrupt") {
      composer.clear(true);
      completion = undefined;
      pasteLines = undefined;
      notification = "草稿已清除，可用输入历史召回。";
      await refresh();
      return;
    }
    if (key.action === "eof") {
      if (!composer.draft.text) requestStop();
      else notification = "草稿非空；Ctrl+D 不会提交或丢弃。";
      await refresh();
      return;
    }
    if (completion && phase === "idle") {
      if (key.action === "up" || key.action === "down") {
        completion.move(key.action === "up" ? -1 : 1);
        await refresh();
        return;
      }
      if (key.action === "tab" || key.action === "submit") {
        const selected = completion.accept() ?? completion.items[0]?.id;
        if (selected) composer.setDraft({ text: `/${selected}`, cursor: selected.length + 1 });
        completion = undefined;
        await refresh();
        return;
      }
    }
    if (key.action === "submit") {
      if (phase !== "idle" || !ready || uiTask) {
        notification = "当前尚不能发送；草稿保留，不排队。";
        await refresh();
        return;
      }
      const text = composer.draft.text;
      if (pasteLines) {
        composer.clear();
        if (text === "/end") {
          const value = pasteLines.join("\n");
          pasteLines = undefined;
          if (value.trim()) {
            await output(() => renderer.user(value));
            launchQuery(() => host.run(value));
          }
        } else pasteLines.push(text === "//end" ? "/end" : text);
        await refresh();
        return;
      }
      if (!text.trim()) return;
      const submitted = parseSubmittedText(text);
      if (submitted.type === "unknown-command") {
        notification = "未知命令；正文以 / 开头请使用 //。";
        await refresh();
        return;
      }
      composer.remember();
      composer.clear();
      if (submitted.type === "command") launchUI(() => localCommand(submitted.name));
      else {
        await output(() => renderer.user(submitted.text));
        launchQuery(() => host.run(submitted.text));
      }
    } else {
      composer.edit(key);
      if (
        phase === "idle" &&
        !pasteLines &&
        key.action !== "newline" &&
        !(key.action === "insert" && key.source === "paste") &&
        /^\/[a-z-]*$/.test(composer.draft.text)
      ) {
        completion = createSelector(
          LOCAL_COMMANDS.filter((name) => name.startsWith(composer.draft.text.slice(1))).map(
            (name) => ({ id: name, label: `/${name}` }),
          ),
          null,
        );
      } else completion = undefined;
    }
    await refresh();
  }

  terminal = createNodeTerminal({
    input: options.input,
    output: options.output,
    error: options.error,
    enabled:
      inputIsTTY && !command.print && command.output !== "jsonl" && command.prompt === undefined,
    noColor: command.noColor,
    onKey(event) {
      events = events
        .then(() => dispatch(event))
        .catch(async (error: unknown) => {
          await report(error, "input");
          requestStop(true);
        });
    },
    onResize() {
      void refresh();
    },
    onEnd() {
      eof = true;
      if (pasteLines) {
        pasteLines = undefined;
        void output(() => renderer.message("未结束的多行草稿未提交。"));
      }
      requestStop();
    },
    onError(error) {
      void report(error, "input").finally(() => requestStop(true));
    },
  });
  if (terminal.mode === "headless") oneShot = true;
  renderer = createTerminalRenderer({
    mode:
      command.output === "jsonl"
        ? "jsonl"
        : command.print || command.prompt !== undefined || terminal.mode === "headless"
          ? "print"
          : terminal.mode,
    color: terminal.color,
    columns: () => terminal.columns,
    rows: () => terminal.rows,
    writeOutput: options.writeOutput,
    writeError: options.writeError,
  });
  const onInterrupt = () => {
    if (settlingCancellation) return;
    if (phase === "starting") {
      cancelRequested = true;
      requestStop(true);
    } else if (
      active ||
      pendingInteraction ||
      phase === "running" ||
      phase === "submitting" ||
      phase === "cancelling"
    ) {
      cancelRequested = true;
      active?.cancel("用户取消");
      if (pendingInteraction) resolveFocus(undefined);
    } else if (oneShot) {
      cancelRequested = true;
      requestStop();
    } else {
      composer.clear(true);
      void refresh();
    }
  };
  const onTerminate = () => {
    terminated = true;
    requestStop(true);
  };
  const onOutputError = (error: unknown) => {
    if (isPipeError(error)) brokenPipe = true;
    else noteFailure("output");
    outputFailed = true;
    requestStop(true);
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  options.output.on("error", onOutputError);
  options.error.on("error", onOutputError);
  terminal.setGeneration(generation);
  try {
    terminal.start();
    await refresh();
    await withActivity("正在打开本地宿主与模型配置", () =>
      host.open({
        ...(command.modelId ? { modelId: command.modelId } : {}),
        ...(command.threadId ? { threadId: command.threadId } : {}),
        ...(command.toolsMode ? { toolsMode: command.toolsMode } : {}),
        ...(!oneShot && terminal.mode !== "headless" ? { setup } : {}),
      }),
    );
    if (!stopping) {
      ready = true;
      phase = "idle";
      switchFocus({ type: "composer" });
      await sessionRecord();
      await refresh();
      if (command.queryId) launchQuery(() => host.resume(command.queryId!));
      else if (command.prompt !== undefined) launchQuery(() => host.run(command.prompt!));
      else if (oneShot) requestStop();
      await finished;
    }
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "CLI_SETUP_CANCELLED" || (stopping && code === "HOST_CLOSED")) stopping = true;
    else {
      await report(error, ready ? "activation" : "configuration");
      stopping = true;
    }
  } finally {
    stopping = true;
    resolveFocus(undefined);
    if (runTask) await runTask;
    if (uiTask) await uiTask;
    phase = "closing";
    try {
      await host.close();
    } catch (error) {
      await report(error, "close");
    }
    try {
      await terminal.close();
    } catch (error) {
      await report(error, "input");
    }
    await events;
    await output(() => renderer.close());
    let decision: TerminalExitDecision;
    if (failure) decision = { exitCode: 1, reason: "failure", stage: failure };
    else if (brokenPipe) decision = { exitCode: 141, reason: "broken-pipe" };
    else if (terminated || lastResult?.status === "interrupted")
      decision = { exitCode: 143, reason: "host-terminated" };
    else if (lastResult?.status === "waiting") decision = { exitCode: 3, reason: "waiting" };
    else if (
      (cancelRequested && !lastResult) ||
      (oneShot && (cancelRequested || userCancelledQuery) && lastResult?.status === "cancelled")
    )
      decision = { exitCode: 130, reason: "user-cancelled" };
    else
      decision = { exitCode: 0, reason: lastResult?.status === "completed" ? "completed" : "idle" };
    await output(() =>
      renderer.record({
        version: 1,
        type: "process.finished",
        ...decision,
        ...(lastIdentity
          ? {
              lastRun: {
                identity: lastIdentity,
                ...(lastResult ? { status: lastResult.status } : {}),
              },
            }
          : {}),
      }),
    );
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    options.output.removeListener("error", onOutputError);
    options.error.removeListener("error", onOutputError);
    finalCode = failure ? 1 : brokenPipe ? 141 : decision.exitCode;
  }
  return finalCode;
}
