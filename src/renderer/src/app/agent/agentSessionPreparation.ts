import { formatPublicErrorMessage } from "@shared/agent-activity-display";
import { createSessionTitleFromPrompt, type SessionBootstrap } from "@shared/session";
import { getBuiltinTemplate } from "@shared/template-catalog";
import { APPLICATION_DEFAULT_TEMPLATE_ID, isUploadedTemplateId } from "@shared/template-protocol";
import { useProjectStore } from "../../components/project-store";
import { loadPersistedUiSettings } from "../appBootstrap";

interface EnsureAgentSessionOptions {
  activeSessionId: string;
  prompt: string;
  localStoragePath: string;
  applySessionState: (state: SessionBootstrap) => void;
  notify: (message: string) => void;
}

/**
 * 确保本次运行拥有持久化 session。
 * 会话创建及其失败反馈在此闭环，避免消息构造和 Agent 执行逻辑感知草稿会话状态。
 */
export async function ensureAgentSession({
  activeSessionId,
  prompt,
  localStoragePath,
  applySessionState,
  notify,
}: EnsureAgentSessionOptions): Promise<string | undefined> {
  if (activeSessionId) return activeSessionId;

  try {
    const title = createSessionTitleFromPrompt(prompt);
    const persisted = loadPersistedUiSettings();
    const requestedTemplateId = persisted.defaultTemplateId ?? APPLICATION_DEFAULT_TEMPLATE_ID;
    const defaultTemplateId = isUploadedTemplateId(requestedTemplateId)
      ? requestedTemplateId
      : (getBuiltinTemplate(requestedTemplateId)?.id ?? APPLICATION_DEFAULT_TEMPLATE_ID);
    const state = await window.desktopApi.createSession(
      localStoragePath
        ? { rootPath: localStoragePath, title, defaultTemplateId }
        : { title, defaultTemplateId },
    );
    applySessionState(state);
    return state.activeSession!.session.id;
  } catch (error) {
    notify(formatPublicErrorMessage(error, "创建会话失败，请重试。"));
    return undefined;
  }
}

export interface PreparedAgentContext {
  sessionId: string;
  projectId: string;
}

/**
 * 显式完成 Session 与 Renderer Project 上下文准备，避免调用方依赖
 * applySessionState 会同步初始化 Project Store 的隐藏行为。
 */
export async function prepareAgentContext(
  options: EnsureAgentSessionOptions,
): Promise<PreparedAgentContext | undefined> {
  const sessionId = await ensureAgentSession(options);
  if (!sessionId) return undefined;

  const project = useProjectStore.getState().activeProject;
  if (!project) {
    options.notify("项目会话尚未准备好，请稍后再试");
    return undefined;
  }

  return { sessionId, projectId: project.id };
}
