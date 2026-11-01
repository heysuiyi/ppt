import {
  agentExecutionStrategySchema,
  agentModelSelectionSchema,
} from "@agent-harness/configuration/model-contract";
import { DEFAULT_DESIGN_SYSTEM } from "@design-system";
import { z } from "zod";
import { agentActivityItemSchema } from "./agent-activity";
import { persistedDisplayCardSchema } from "./card-display-protocol";
import { type Presentation, presentationSchema } from "./presentation";

export const projectArtifactKindSchema = z.enum([
  "design-spec",
  "template-policy",
  "page-plan",
  "page-svg",
  "assets",
  "deck",
  "export-history",
  "reference",
]);

export const projectArtifactSchema = z.object({
  id: z.string(),
  title: z.string(),
  path: z.string(),
  kind: projectArtifactKindSchema,
});

export const projectSandboxSchema = z.object({
  rootPath: z.string(),
  artifacts: z.array(projectArtifactSchema),
});

const _persistedOutlineSchema = z.object({
  threadId: z.string(),
  message: z.string(),
  outline: z
    .object({
      title: z.string(),
      audience: z.string().optional(),
      objective: z.string().optional(),
      slides: z.array(
        z.object({
          title: z.string(),
          keyPoints: z.array(z.string()),
        }),
      ),
    })
    .optional(),
  missingInformation: z.array(z.string()),
  model: agentModelSelectionSchema.optional(),
  executionStrategy: agentExecutionStrategySchema.optional(),
});

export const sessionChatMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    /** Ordered run blocks; response ranges project content into the visual timeline. */
    activityTrace: z.array(agentActivityItemSchema).optional(),
    runId: z.string().optional(),
    runStatus: z.enum(["running", "waiting", "completed", "interrupted", "failed"]).optional(),
    runError: z.string().optional(),
    /** Epoch ms when the assistant run started (renderer wall clock). */
    runStartedAt: z.number().int().optional(),
    /** Wall duration of the run; stamped on finalize / interrupt recovery. */
    runDurationMs: z.number().int().nonnegative().optional(),
    threadId: z.string().optional(),
  })
  .strict()
  .superRefine((message, context) => {
    if (message.role !== "assistant" || !message.runId) return;
    const responses = (message.activityTrace ?? []).filter((item) => item.kind === "response");
    if (message.content.length > 0 && responses.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["activityTrace"],
        message: "Run messages with text must describe it with ordered response blocks.",
      });
      return;
    }

    let cursor = 0;
    for (const response of responses) {
      if (
        response.start !== cursor ||
        response.end < response.start ||
        response.end > message.content.length
      ) {
        context.addIssue({
          code: "custom",
          path: ["activityTrace"],
          message: "Response block offsets must be contiguous and within message content.",
        });
        return;
      }
      cursor = response.end;
    }
    if (cursor !== message.content.length) {
      context.addIssue({
        code: "custom",
        path: ["activityTrace"],
        message: "Response blocks must cover the complete run message content.",
      });
    }
  });

export const sessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastMessageAt: z.string().optional(),
  slideCount: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  workspacePath: z.string().optional(),
});

export const sessionSnapshotSchema = z.object({
  session: sessionSummarySchema,
  project: projectSandboxSchema.optional(),
  presentation: presentationSchema,
  messages: z.array(sessionChatMessageSchema),
  displayCards: z.array(persistedDisplayCardSchema).default([]),
});

export const sessionBootstrapSchema = z.object({
  sessions: z.array(sessionSummarySchema),
  activeSession: sessionSnapshotSchema.optional(),
});

export type SessionChatMessage = z.infer<typeof sessionChatMessageSchema>;
export type ProjectArtifact = z.infer<typeof projectArtifactSchema>;
export type ProjectSandbox = z.infer<typeof projectSandboxSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type SessionBootstrap = z.infer<typeof sessionBootstrapSchema>;

export const DEFAULT_SESSION_TITLE_PREFIX = "新 PPT 项目";
const MAX_AUTO_SESSION_TITLE_LENGTH = 28;

export function createDefaultSessionTitle(index: number): string {
  return `${DEFAULT_SESSION_TITLE_PREFIX} ${index}`;
}

export function createSessionTitleFromPrompt(
  prompt: string,
  fallback = DEFAULT_SESSION_TITLE_PREFIX,
): string {
  const normalized = prompt
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[#>*\-\d.\s]+/g, "")
    .trim();

  if (!normalized) return fallback;

  const withoutLeadIn = normalized
    .replace(/^(?:请|麻烦你?)\s*/u, "")
    .replace(/^(?:帮我|帮忙|给我|为我|我想|我要|需要)\s*/u, "")
    .replace(/^(?:做一份|做一个|做个|制作|创建|生成|设计|整理)\s*/u, "")
    .replace(/^(?:一份|一个|一套|一页|一篇)\s*/u, "")
    .replace(/^(?:please\s+)?(?:create|make|generate|draft|build|design)\s+(?:a|an|the)?\s*/i, "")
    .trim();
  const candidate = (withoutLeadIn || normalized).replace(/[。！？!?；;，,：:、\s]+$/u, "").trim();

  if (!candidate) return fallback;

  const characters = Array.from(candidate);
  return characters.length > MAX_AUTO_SESSION_TITLE_LENGTH
    ? `${characters.slice(0, MAX_AUTO_SESSION_TITLE_LENGTH).join("")}...`
    : candidate;
}

export function createSessionPresentation(title: string): Presentation {
  // 新项目从空 deck 起步：不预置占位页，避免 Agent 每次 ReadPresentationSnapshot
  // 都读到无意义的占位内容。首页内容由 Agent 首次 add-slide 生成。
  return {
    id: crypto.randomUUID(),
    title,
    revision: 0,
    designSystem: DEFAULT_DESIGN_SYSTEM,
    slides: [],
  };
}

export function createWelcomeMessage(title?: string): SessionChatMessage {
  return {
    id: "init",
    role: "assistant",
    content: title
      ? `已为您创建 PPT 项目【${title}】。这个会话以项目目录为沙箱；新建演示将依次产出 design/design-spec.json、slides/page-plan.json 与 slides/svg/ 页面，并由预览、提案和应用记录证明进度。`
      : "已初始化一个 PPT 项目沙箱。新建演示会以设计规范、逐页规划和完整页面 SVG 作为作者文件；Brief、大纲和研究资料按需使用。",
  };
}
