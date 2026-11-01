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
import type {
  TerminalConnectionItem,
  TerminalConnectionTarget,
  TerminalHost,
  TerminalSetupIO,
  TerminalToolsMode,
} from "../host/host-contract.js";
import { createComposer } from "./composer.js";
import { composerContentWidth } from "./composer-layout.js";
import type { Composer, NodeTerminal, Selector, TerminalKeyEvent } from "./input-contract.js";
import { createTerminalRenderer } from "./interactive-renderer.js";
import { modelPanelEditorWidth } from "./model-panel.js";
import { createNodeTerminal } from "./node-terminal.js";
import { createPreviewBuffer } from "./preview-buffer.js";
import type {
  TerminalFeedback,
  TerminalInputView,
  TerminalRenderer,
  TerminalSelectorView,
  TerminalView,
} from "./renderer-contract.js";
import { createSelector } from "./selector.js";
import type {
  TerminalExitDecision,
  TerminalFailureStage,
  TerminalHistoryEntry,
  TerminalModelItem,
  TerminalPhase,
  TerminalSelectionItem,
} from "./terminal-contract.js";
import {
  interactionReference,
  projectTerminalEvent,
  projectTerminalSettlement,
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
  readonly connections: readonly TerminalConnectionItem[];
  readonly actionId: string;
  groups: Selector;
  action?: TerminalSelectionItem;
  pane: "groups" | "models";
}

type ModelPanelSelection =
  | { readonly type: "model"; readonly modelId: string }
  | {
      readonly type: "configure";
      readonly connection: TerminalConnectionTarget;
      readonly groupId: string;
    };

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

type BlockingScope = "catalog" | "model" | "connection" | "binding" | "interaction";

// Only authoritative failed results with these reviewed public model codes can
// return to input. Protocol/replay, ownership, persistence and unknown failures stop.
const recoverableModelFailures: Readonly<Record<string, true>> = {
  ADAPTER_UNSUPPORTED: true,
  CONFIGURATION: true,
  MODEL_CAPABILITY: true,
  AUTHENTICATION: true,
  ACCESS_DENIED: true,
  PAYMENT_REQUIRED: true,
  RATE_LIMIT_OR_QUOTA: true,
  SERVICE_UNAVAILABLE: true,
  TIMEOUT: true,
  NETWORK: true,
  TRUNCATED: true,
  MODEL_TRUNCATED: true,
  MODEL_STOPPED: true,
};

/** 一个控制器拥有输入、观察消费、当前句柄及退出；等待不保留 Core Run 调用栈。 */
export async function runTerminalController(options: TerminalControllerOptions): Promise<number> {
  const { command, host } = options;
  let phase: TerminalPhase = "starting";
  let scene: TerminalView["scene"] = command.threadId ? "conversation" : "startup";
  let displayContext: TerminalView["context"];
  let generation = 0;
  let focus: Focus = { type: "composer" };
  const composer = createComposer();
  const feedback: {
    input?: TerminalFeedback;
    blocking?: TerminalFeedback & { readonly scope: BlockingScope };
    notice?: TerminalFeedback;
  } = {};
  let activity: string | undefined;
  let runActivity = "等待模型响应";
  let modelAvailability: TerminalModelItem["availability"];
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
  let modelPanelBrowser: TerminalSelectorView | undefined;
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
    completion = undefined;
  }

  function resolveFocus(value: string | undefined): void {
    const current = focus;
    if (current.type === "selector" && current.navigation)
      modelPanelBrowser = currentView().selector;
    delete feedback.input;
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

  function onOutputError(error: unknown): void {
    outputFailed = true;
    if (isPipeError(error)) brokenPipe = true;
    else noteFailure("output");
    requestStop(true);
  }

  async function output(action: () => Promise<void>): Promise<void> {
    if (outputFailed) return;
    try {
      await action();
    } catch (error) {
      onOutputError(error);
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

  function setFeedback(kind: "input" | "notice", message: string): void {
    feedback[kind] = { kind, message };
  }

  function setBlocking(scope: BlockingScope, message: string): void {
    feedback.blocking = { kind: "blocking", scope, message };
  }

  function clearBlocking(scope: BlockingScope): void {
    if (feedback.blocking?.scope === scope) delete feedback.blocking;
  }

  function sizeEditors(): void {
    const framed = terminal.mode === "tui" && terminal.columns >= 40 && terminal.rows >= 12;
    const columns = framed
      ? composerContentWidth(terminal.columns - 1)
      : Math.max(1, terminal.columns - 3);
    composer.setColumns(columns);
    if (focus.type === "text")
      focus.editor.setColumns(
        framed && modelPanelBrowser
          ? modelPanelEditorWidth(modelPanelBrowser, terminal.columns)
          : columns,
      );
  }

  function inputView(): TerminalInputView {
    const narrow = terminal.columns < 60;
    if (pendingInteraction && (focus.type === "selector" || focus.type === "text"))
      return {
        purpose: focus.type === "text" && focus.secret ? "secret" : "interaction",
        status: "等待明确审批",
        hint:
          focus.type === "selector"
            ? narrow
              ? "Esc等待 · Enter答 · ↑↓选 · Tab不批"
              : "Esc 保持等待 · Enter 确认 · ↑↓ 选择 · Tab 不批准 · Ctrl+C 取消"
            : narrow
              ? "Esc等待 · Enter回答 · ^C取消"
              : "Esc 保持等待 · Enter 提交回答 · Ctrl+C 取消",
      };
    if (focus.type === "text")
      return {
        purpose: focus.secret ? "secret" : "prompt",
        status: focus.secret ? "等待安全输入" : "等待输入",
        hint: narrow
          ? "Esc返回 · Enter确认 · Alt+Enter换行"
          : "Esc 返回 · Enter 确认 · Alt+Enter 换行",
      };
    if (focus.type === "selector")
      return {
        purpose: focus.navigation ? "model-selector" : "selector",
        status: focus.navigation ? "选择模型" : "等待选择",
        hint: focus.navigation
          ? narrow
            ? "Esc返回 · Enter选 · Tab切栏 · ↑↓"
            : "Esc 返回 · Enter 选择 · ←→/Tab 切栏 · ↑↓ 移动 · 输入搜索"
          : narrow
            ? "Esc返回 · Enter/Tab确认 · ↑↓选"
            : "Esc 返回 · Enter/Tab 确认 · ↑↓ 选择 · 输入筛选",
      };
    if (completion)
      return {
        purpose: "completion",
        status: "",
        hint: "",
      };
    if (settlingCancellation || phase === "cancelling")
      return {
        purpose: "composer",
        status: "正在结算取消",
        hint: "",
      };
    if (phase === "waiting")
      return {
        purpose: "interaction",
        status: "等待明确审批",
        hint: narrow ? "Esc等待 · ^C取消 · 无默认批准" : "Esc 保持等待 · Ctrl+C 取消 · 无默认批准",
      };
    if (phase === "running" || phase === "submitting" || phase === "settling")
      return {
        purpose: "composer",
        status:
          phase === "running"
            ? runActivity
            : phase === "submitting"
              ? "正在提交回答"
              : "正在保存结果",
        hint: "",
      };
    if (!ready || phase !== "idle" || uiTask)
      return {
        purpose: "composer",
        status: activity ?? (!ready ? "正在初始化" : ""),
        hint: "",
      };
    return {
      purpose: "composer",
      status: pasteLines ? "多行输入中；等待 /end" : "",
      hint: pasteLines
        ? narrow
          ? "/end发送 · //end插入 · EOF不发送"
          : "独立行 /end 发送 · //end 插入 /end · EOF 不发送"
        : "",
    };
  }

  function currentView(): TerminalView {
    sizeEditors();
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
                    ...(focus.navigation.action ? { action: focus.navigation.action } : {}),
                  },
                }
              : {}),
          }
        : undefined;
    const currentFeedback = feedback.blocking ?? feedback.input ?? feedback.notice;
    const availability = modelAvailability;
    const activityText =
      settlingCancellation || phase === "cancelling"
        ? "正在结算取消"
        : phase === "running"
          ? runActivity
          : phase === "submitting"
            ? "正在提交回答"
            : phase === "settling"
              ? "正在保存结果"
              : phase === "waiting"
                ? "等待明确审批"
                : (activity ?? (!ready ? "正在初始化" : undefined));
    return {
      phase,
      scene,
      input: inputView(),
      ...(activityText ? { activity: activityText } : {}),
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
      ...(displayContext
        ? {
            context: {
              ...displayContext,
              ...(availability?.state === "unavailable"
                ? { modelStatus: availability.reason }
                : {}),
            },
          }
        : {}),
      ...(selector ? { selector } : {}),
      ...(modelPanelBrowser && !selector?.navigation
        ? { modelPanel: { browser: modelPanelBrowser } }
        : {}),
      ...(completion
        ? {
            completion: {
              title: "命令补全 · 接受后仍需再次 Enter",
              query: "",
              items: completion.items,
              selectedId: completion.selectedId,
            },
          }
        : {}),
      ...(pendingInteraction
        ? {
            interaction: {
              reference: interactionReference(pendingInteraction),
              display: host.describeInteraction(pendingInteraction),
            },
          }
        : {}),
      ...(focus.type === "text" ? { prompt: { text: focus.prompt, secret: focus.secret } } : {}),
      ...(currentFeedback
        ? { feedback: { kind: currentFeedback.kind, message: currentFeedback.message } }
        : {}),
    };
  }

  async function refresh(): Promise<void> {
    if (outputFailed || stopping || phase === "closing") return;
    const view = currentView();
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

  function filterModels(current: Extract<Focus, { type: "selector" }>): void {
    const navigation = current.navigation!;
    const group = navigation.groups.selectedId;
    const items = navigation.models
      .filter(
        (model) =>
          group === "all" || (model.vendor ? `vendor:${model.vendor.id}` : "legacy") === group,
      )
      .map((model) => ({
        id: model.id,
        label: `${model.modelName ? `${model.vendor ? `${model.vendor.label}/` : ""}${model.modelName}` : model.label}${model.id === host.context.model.id ? " · 当前" : ""}${model.availability?.state === "unavailable" ? " · 不可用" : ""}`,
        description: `${model.vendor?.label ?? "已配置连接"} · ${model.availability?.reason ?? "本地状态未提供"}`,
      }));
    const connection = navigation.connections.find((item) => item.id === group);
    navigation.action =
      connection?.target.type === "existing"
        ? { id: navigation.actionId, label: "配置此连接 / 发现模型" }
        : undefined;
    current.sourceItems = navigation.action ? [...items, navigation.action] : items;
    const filtered = createSelector(items);
    // Plain 数字是当前组的稳定序号，不作为搜索条件；配置动作永不被搜索隐藏。
    filtered.search(terminal.mode === "plain" && /^\d+$/.test(current.typed) ? "" : current.typed);
    current.selector = createSelector(
      navigation.action ? [...filtered.items, navigation.action] : filtered.items,
      current.selector.selectedId,
    );
  }

  async function askModel(
    models: readonly TerminalModelItem[],
    connections: readonly TerminalConnectionItem[],
    selectedGroupId = "all",
    pane: ModelNavigation["pane"] = "models",
  ): Promise<ModelPanelSelection | undefined> {
    if (stopping || eof) return undefined;
    const groups: TerminalSelectionItem[] = [
      { id: "all", label: "All · 全部模型", description: `${models.length} 个模型` },
      ...connections.filter((item) => item.target.type === "existing"),
    ];
    for (const model of models) {
      const id = model.vendor ? `vendor:${model.vendor.id}` : "legacy";
      if (!groups.some((group) => group.id === id))
        groups.push({ id, label: model.vendor?.label ?? "已配置连接" });
    }
    groups.push(...connections.filter((item) => item.target.type === "new"));
    let actionId = "__configure_connection";
    while (models.some((model) => model.id === actionId)) actionId += "_";
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    const next: Extract<Focus, { type: "selector" }> = {
      type: "selector",
      title: "Models",
      selector: createSelector([], host.context.model.id),
      sourceItems: [],
      typed: "",
      navigation: {
        models,
        connections,
        actionId,
        groups: createSelector(groups, selectedGroupId),
        pane,
      },
      resolve,
    };
    filterModels(next);
    next.selector = createSelector(next.selector.items, host.context.model.id);
    switchFocus(next);
    await refresh();
    const selected = await promise;
    if (!selected) return undefined;
    if (selected === actionId) {
      const groupId = next.navigation!.groups.selectedId!;
      const connection = connections.find((item) => item.id === groupId);
      return connection ? { type: "configure", connection: connection.target, groupId } : undefined;
    }
    return { type: "model", modelId: selected };
  }

  async function loadModels(): Promise<readonly TerminalModelItem[] | undefined> {
    return withActivity("正在加载模型目录", async () => {
      try {
        const models = await host.models();
        clearBlocking("catalog");
        return models;
      } catch (error) {
        setBlocking("catalog", `模型目录加载失败：${terminalError(error).message}`);
        await output(() => renderer.message(feedback.blocking!.message));
        return undefined;
      }
    });
  }

  async function loadConnections(): Promise<readonly TerminalConnectionItem[]> {
    return withActivity("正在加载连接目录", async () => {
      try {
        return await host.connections();
      } catch (error) {
        setBlocking("catalog", `连接目录加载失败：${terminalError(error).message}`);
        return [];
      }
    });
  }

  async function configureConnection(
    target: TerminalConnectionTarget,
  ): Promise<string | undefined> {
    let selected: string | undefined;
    try {
      selected = await withActivity("正在配置连接", () => host.configureModel(setup, target));
    } catch (error) {
      if (terminalError(error).code !== "HOST_CONFIGURATION_REJECTED") throw error;
      setBlocking(
        "connection",
        `连接配置未完成：${terminalError(error).message}；当前会话保持不变。`,
      );
      return undefined;
    }
    if (!selected) return undefined;
    clearBlocking("connection");
    setFeedback("notice", "连接与 CLI 默认模型已保存；当前会话未切换，须另确认新建绑定。");
    await output(() => renderer.message(feedback.notice!.message));
    return selected;
  }

  async function chooseModel(connect: boolean): Promise<void> {
    try {
      let models = (await loadModels()) ?? [];
      let connections = await loadConnections();
      let groupId = "all";
      let pane: ModelNavigation["pane"] = connect ? "groups" : "models";
      for (;;) {
        const currentId = host.context.model.id;
        modelAvailability = models.find((item) => item.id === currentId)?.availability;
        const choice = await askModel(models, connections, groupId, pane);
        if (!choice) return;
        groupId = modelPanelBrowser?.navigation?.selectedGroupId ?? "all";
        let selectedId: string | undefined;
        if (choice.type === "configure") {
          selectedId = await configureConnection(choice.connection);
          groupId = choice.groupId;
          pane = "groups";
        } else {
          selectedId = choice.modelId;
          pane = "models";
        }
        // 配置可能改变目录；绑定前重读权威状态，取消配置仍返回同一面板。
        models = (await loadModels()) ?? [];
        connections = await loadConnections();
        if (!selectedId) continue;
        const selected = models.find((item) => item.id === selectedId);
        if (!selected) {
          setBlocking("model", "未找到所选模型；当前会话保持不变。已保存的连接配置不会删除。");
          continue;
        }
        if (selected.availability?.state !== "unavailable") clearBlocking("model");
        if (selected.id === currentId) {
          setFeedback("notice", "当前模型已选中；未创建新会话。");
          return;
        }
        if (selected.availability?.state === "unavailable") {
          setBlocking("model", `模型不可用：${selected.availability.reason}`);
          continue;
        }
        if (!(await confirmSwitch(`模型 ${selected.label}`))) {
          setFeedback(
            "notice",
            "已取消模型切换；当前模型、会话与草稿保持不变；已保存的连接/默认配置保留。",
          );
          continue;
        }
        await withActivity(`正在切换模型：${selected.label}`, async () => {
          await host.newSession({ modelId: selected.id });
          modelPanelBrowser = undefined;
          await bindSession([]);
        });
        modelAvailability = selected.availability;
        setFeedback(
          "notice",
          `已切换模型：${host.context.model.label}；新绑定会话 ${host.context.threadId}`,
        );
        await output(() => renderer.message(feedback.notice!.message));
        return;
      }
    } finally {
      modelPanelBrowser = undefined;
    }
  }

  const setup: TerminalSetupIO = {
    text: (prompt) => askText(prompt),
    secret: (prompt) => askText(prompt, true),
    select: askSelection,
    notify: async (text) => {
      if (modelPanelBrowser) {
        setFeedback("input", text);
        await refresh();
      } else await output(() => renderer.message(text));
    },
  };

  async function sessionRecord(): Promise<void> {
    clearBlocking("binding");
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

  async function bindSession(history: readonly TerminalHistoryEntry[]): Promise<void> {
    const context = host.context;
    // Host can publish its target before an await returns. Refreshes retain the
    // previous display snapshot until context and history are ready together.
    displayContext = {
      workspace: context.workspaceRoot,
      threadId: context.threadId,
      model: context.model.modelName ?? context.model.id,
      capabilities: context.toolsMode,
    };
    modelAvailability = context.model.availability ? { ...context.model.availability } : undefined;
    scene = history.length ? "conversation" : "home";
    pendingInteraction = undefined;
    lastIdentity = undefined;
    lastResult = undefined;
    cancelRequested = false;
    userCancelledQuery = false;
    settlingCancellation = false;
    delete feedback.input;
    delete feedback.notice;
    clearBlocking("binding");
    switchFocus({ type: "composer" });
    await output(() => renderer.bindSession(currentView(), history));
    await sessionRecord();
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
          setFeedback("input", "必须输入当前完整 interactionId。");
          await refresh();
          continue;
        }
        if (split[0] === "cancel") return { type: "cancel", interactionId: request.id };
        if (display.support !== "supported") {
          setBlocking("interaction", "不支持此交互格式；只能取消或保留等待。");
          continue;
        }
        try {
          return host.answerInteraction(request, split[0]!, split[1]);
        } catch (error) {
          const code = terminalError(error).code;
          if (
            code !== "CLI_INTERACTION_CHOICE_INVALID" &&
            code !== "CLI_INTERACTION_UNSUPPORTED" &&
            code !== "STALE_INTERACTION"
          )
            throw error;
          setFeedback("input", "交互选项或确认身份无效；等待保持。");
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
        setFeedback("input", "等待保持，未批准或拒绝。");
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
      } catch (error) {
        const code = terminalError(error).code;
        if (
          code !== "CLI_INTERACTION_CHOICE_INVALID" &&
          code !== "CLI_INTERACTION_UNSUPPORTED" &&
          code !== "STALE_INTERACTION"
        )
          throw error;
        setFeedback("input", "交互选项或确认身份无效；等待保持。");
      }
    }
    return undefined;
  }

  async function executeQuery(start: () => Promise<AgentRunHandle>): Promise<void> {
    phase = "running";
    runActivity = "等待模型响应";
    cancelRequested = false;
    userCancelledQuery = false;
    await refresh();
    let handle = await start();
    for (;;) {
      active = handle;
      lastIdentity = handle.identity;
      lastResult = undefined;
      await output(() => renderer.beginRun(handle.identity));
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
            const nextActivity =
              event.type === "model.delta" && event.delta.type === "reasoning"
                ? "正在思考"
                : event.type === "model.delta" || event.type === "model.preview"
                  ? "正在生成"
                  : event.type === "tool.started"
                    ? "正在执行工具"
                    : event.type === "tool.completed"
                      ? "等待模型响应"
                      : runActivity;
            if (runActivity !== nextActivity) {
              runActivity = nextActivity;
              await refresh();
            }
            const record = projectTerminalEvent(event, (request) =>
              host.describeInteraction(request),
            );
            if (record) await output(() => renderer.record(record));
            if (event.type === "model.delta" || event.type === "model.preview")
              await output(() => renderer.preview(preview.update(event)));
          }
        } catch (error) {
          await report(error, "observation");
          requestStop(true);
        }
      })();
      let result: AgentRunResult;
      try {
        result = await handle.completed;
      } finally {
        await observing;
        active = undefined;
        preview.clear();
      }
      settlingCancellation = false;
      phase = "settling";
      lastResult = result;
      const settlement = projectTerminalSettlement(result, (request) =>
        host.describeInteraction(request),
      );
      await output(() => renderer.settle(settlement));
      if (result.status === "failed") {
        if (oneShot || stopping || !Object.hasOwn(recoverableModelFailures, result.error.code)) {
          noteFailure("completion");
          requestStop();
        }
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
      clearBlocking("interaction");
      if (response.type === "cancel") userCancelledQuery = true;
      settlingCancellation = response.type === "cancel";
      phase = "submitting";
      pendingInteraction = undefined;
      switchFocus({ type: "composer" });
      await refresh();
      if (settlingCancellation) cancelRequested = false;
      handle = await host.resume(result.identity.queryId, response);
      runActivity = "等待模型响应";
      phase = "running";
      await refresh();
    }
    pendingInteraction = lastResult?.status === "waiting" ? lastResult.interaction : undefined;
    if (stopping || oneShot || eof || lastResult?.status === "waiting") {
      stopping = true;
      finish();
    }
  }

  function launchQuery(start: () => Promise<AgentRunHandle>): void {
    if (runTask || stopping) return;
    scene = "conversation";
    delete feedback.notice;
    const task = executeQuery(start)
      .catch(async (error: unknown) => {
        await output(() => renderer.preview([]));
        await report(error, "completion");
        requestStop();
      })
      .finally(async () => {
        runTask = undefined;
        if (stopping || eof) finish();
        else {
          phase = "idle";
          cancelRequested = false;
          switchFocus({ type: "composer" });
          await refresh();
        }
      });
    runTask = task;
  }

  function launchUI(action: () => Promise<void>, label: string): void {
    if (uiTask || stopping) return;
    completion = undefined;
    delete feedback.input;
    activity = label;
    uiTask = Promise.resolve()
      .then(action)
      .catch(async (error: unknown) => {
        const publicError = terminalError(error);
        if (publicError.code === "HOST_SWITCH_REJECTED") {
          setBlocking("binding", publicError.message);
        } else {
          await report(error, "activation");
          requestStop();
        }
      })
      .finally(async () => {
        uiTask = undefined;
        activity = undefined;
        await refresh();
      });
  }

  async function withActivity<T>(text: string, operation: () => Promise<T>): Promise<T> {
    const previous = activity;
    activity = text;
    await refresh();
    try {
      return await operation();
    } finally {
      activity = previous;
      await refresh();
    }
  }

  async function confirmSwitch(
    target = "新会话",
    operation: "new" | "resume" = "new",
  ): Promise<boolean> {
    const consequence =
      operation === "resume"
        ? "将恢复已有绑定会话；保留草稿，未完成请求按权威检查点继续。"
        : "将新建绑定会话；保留草稿，不迁移旧 Query。";
    const answer = await askText(`目标：${target}\n${consequence}\n输入 yes 确认：`);
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
        setFeedback("notice", "多行输入：独立行 /end 发送，//end 插入 /end；EOF 不发送。");
        break;
      case "new":
        if (await confirmSwitch()) {
          await withActivity("正在创建绑定会话", async () => {
            await host.newSession();
            await bindSession([]);
          });
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
          await withActivity("正在切换能力与绑定会话", async () => {
            await host.newSession({ toolsMode: selected as TerminalToolsMode });
            await bindSession([]);
          });
        }
        break;
      }
      case "resume": {
        const sessions = await withActivity("正在加载会话目录", () => host.sessions());
        const selected = await askSelection("当前工作区会话", sessions);
        if (selected && (await confirmSwitch(`会话 ${selected}`, "resume"))) {
          const session = await withActivity("正在恢复绑定会话", async () => {
            const target = await host.selectSession(selected);
            await bindSession(target.history);
            return target;
          });
          if (session.unfinished) launchQuery(() => host.resume(session.unfinished!.queryId));
        }
        break;
      }
      case "tools-output": {
        const selected = await askSelection("安全工具输出", renderer.tools());
        if (selected) await output(() => renderer.selectTool(selected));
        break;
      }
      case "thinking": {
        const items = renderer.thoughts();
        if (!items.length) await output(() => renderer.message("当前会话没有可展示的公开思考。"));
        else {
          const selected = await askSelection("公开思考", items);
          if (selected) await output(() => renderer.selectThinking(selected));
        }
        break;
      }
    }
    await refresh();
  }

  async function dispatch(event: TerminalKeyEvent): Promise<void> {
    if (event.generation !== generation || stopping) return;
    const key = event.key;
    sizeEditors();
    if (
      key.action === "insert" ||
      key.action === "backspace" ||
      key.action === "delete" ||
      key.action === "newline"
    ) {
      delete feedback.input;
      delete feedback.notice;
    }
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
      if (focus.navigation) {
        const current = focus;
        const navigation = current.navigation!;
        if (key.action === "interrupt" || key.action === "eof") resolveFocus(undefined);
        else if (key.action === "escape") {
          if (navigation.pane === "models") {
            navigation.pane = "groups";
            current.typed = "";
            filterModels(current);
          } else resolveFocus(undefined);
        } else if (key.action === "left" || key.action === "right" || key.action === "tab") {
          navigation.pane =
            key.action === "left"
              ? "groups"
              : key.action === "right"
                ? "models"
                : navigation.pane === "groups"
                  ? "models"
                  : "groups";
          current.typed = "";
          filterModels(current);
        } else if (key.action === "up" || key.action === "down") {
          const selector = navigation.pane === "groups" ? navigation.groups : current.selector;
          selector.move(key.action === "up" ? -1 : 1);
          if (navigation.pane === "groups") filterModels(current);
        } else if (
          (key.action === "insert" && !key.text.includes("\n")) ||
          key.action === "backspace"
        ) {
          if (terminal.mode !== "plain" && navigation.pane === "groups") {
            navigation.groups = createSelector(navigation.groups.items, "all");
            navigation.pane = "models";
          }
          current.typed =
            key.action === "insert"
              ? current.typed + key.text
              : Array.from(current.typed).slice(0, -1).join("");
          filterModels(current);
        } else if (key.action === "submit") {
          const query = current.typed.trim();
          if (terminal.mode === "plain" && query.startsWith("/")) {
            current.typed = "";
            if (query === "/connect") navigation.pane = "groups";
            else if (query === "/cancel") resolveFocus(undefined);
            else if (query === "/groups" || query === "/back") {
              if (query === "/back" && navigation.pane === "groups") resolveFocus(undefined);
              else navigation.pane = "groups";
            }
            filterModels(current);
          } else if (navigation.pane === "groups") {
            const index = terminal.mode === "plain" && /^\d+$/.test(query) ? Number(query) - 1 : -1;
            const selected =
              index >= 0
                ? navigation.groups.items[index]?.id
                : (navigation.groups.items.find((item) => item.id === query)?.id ??
                  (query ? undefined : navigation.groups.accept()));
            if (selected) {
              navigation.groups = createSelector(navigation.groups.items, selected);
              const connection = navigation.connections.find((item) => item.id === selected);
              if (connection?.target.type === "new") resolveFocus(navigation.actionId);
              else navigation.pane = "models";
              current.typed = "";
              filterModels(current);
            }
          } else {
            if (
              navigation.connections.find((item) => item.id === navigation.groups.selectedId)
                ?.target.type === "new"
            ) {
              resolveFocus(navigation.actionId);
              await refresh();
              return;
            }
            const index = terminal.mode === "plain" && /^\d+$/.test(query) ? Number(query) - 1 : -1;
            const selected =
              index >= 0
                ? current.sourceItems[index]?.id
                : (current.sourceItems.find((item) => item.id === query)?.id ??
                  current.selector.accept());
            if (selected) resolveFocus(selected);
          }
        }
        await refresh();
        return;
      }
      if (key.action === "eof" && phase === "waiting") {
        eof = true;
        requestStop();
      } else if (key.action === "escape" && pendingInteraction) {
        setFeedback("input", "等待保持，未批准或拒绝。");
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
      } else if (key.action === "submit" || (key.action === "tab" && !pendingInteraction)) {
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
    if (key.action === "toggle-thinking") {
      await output(() => renderer.toggleThinking());
      return;
    }
    if (key.action === "select-model") {
      if (phase === "idle" && !uiTask) launchUI(() => localCommand("model"), "正在选择模型");
      else setFeedback("input", "执行或会话切换中不能切换模型。");
      await refresh();
      return;
    }
    if (key.action === "escape") {
      if (completion) {
        completion = undefined;
        await refresh();
        return;
      }
      let dismissed = false;
      await output(async () => {
        dismissed = await renderer.dismissDetail();
      });
      if (dismissed) return;
      if (phase === "running" && !settlingCancellation) {
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
      setFeedback("notice", "草稿已清除，可用输入历史召回。");
      await refresh();
      return;
    }
    if (key.action === "eof") {
      if (!composer.draft.text) requestStop();
      else setFeedback("input", "草稿非空；Ctrl+D 不会提交或丢弃。");
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
        setFeedback("input", "未知命令；正文以 / 开头请使用 //。");
        await refresh();
        return;
      }
      composer.remember();
      composer.clear();
      if (submitted.type === "command")
        launchUI(() => localCommand(submitted.name), `正在处理 /${submitted.name}`);
      else {
        await output(() => renderer.user(submitted.text));
        launchQuery(() => host.run(submitted.text));
      }
    } else {
      const previousText = composer.draft.text;
      composer.edit(key);
      if (composer.draft.text !== previousText) delete feedback.notice;
      if (
        phase === "idle" &&
        !pasteLines &&
        key.action !== "newline" &&
        !(key.action === "insert" && key.source === "paste") &&
        /^\/[a-z-]*$/.test(composer.draft.text)
      ) {
        const items = LOCAL_COMMANDS.filter((item) =>
          item.name.startsWith(composer.draft.text.slice(1)),
        ).map((item) => ({
          id: item.name,
          label: `/${item.name}`,
          description: item.description,
        }));
        completion = createSelector(items, items[0]?.id ?? null);
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
    onOutputError,
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
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  options.output.on("error", onOutputError);
  options.error.on("error", onOutputError);
  terminal.setGeneration(generation);
  try {
    terminal.start();
    await refresh();
    await withActivity("正在打开本地宿主与模型配置", async () => {
      await host.open({
        ...(command.modelId ? { modelId: command.modelId } : {}),
        ...(command.threadId ? { threadId: command.threadId } : {}),
        ...(command.toolsMode ? { toolsMode: command.toolsMode } : {}),
        ...(!oneShot && terminal.mode !== "headless" ? { setup } : {}),
      });
      if (stopping) return;
      const history = command.threadId
        ? (await host.sessions()).find((session) => session.id === host.context.threadId)?.history
        : [];
      if (!history) throw new Error("Opened session history is unavailable");
      activity = undefined;
      ready = true;
      phase = "idle";
      await bindSession(history);
    });
    if (!stopping) {
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
