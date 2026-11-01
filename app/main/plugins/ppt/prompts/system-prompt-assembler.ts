import { type SystemPromptContext, serializeSystemPromptContextKey } from "./prompt-context";
import {
  buildIdentitySection,
  buildMemorySection,
  buildResponseProtocolSection,
  buildRuntimeContextSection,
  buildToolsSection,
  buildWorkspaceSection,
  PROMPT_SECTION_DEFS,
  type PromptSectionCacheScope,
  type PromptSectionId,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from "./prompt-sections";

export interface AssembledPromptSection {
  id: PromptSectionId;
  content: string;
  cacheScope: PromptSectionCacheScope;
}

export interface AssembledSystemPrompt {
  sections: AssembledPromptSection[];
  /** Full prompt string for gateway APIs that accept a single system field. */
  text: string;
  /** Thread-independent prefix eligible for provider prompt caching. */
  staticPrefix: string;
  /** Per-query suffix containing tools, runtime, workspace, and memory facts. */
  dynamicSuffix: string;
}

export interface SystemPromptSectionProvider {
  id: PromptSectionId;
  order: number;
  cacheScope: PromptSectionCacheScope;
  render(context: SystemPromptContext): string | undefined;
}

interface CacheEntry {
  contextKey: string;
  registryRevision: number;
  result: AssembledSystemPrompt;
}

/**
 * Section registry and cache boundary for system-prompt composition.
 *
 * Features may register a section without editing the central assembler. A
 * provider must explicitly choose global (thread-independent) or dynamic
 * caching; changing the registry invalidates all assembled thread entries.
 */
export class SystemPromptManager {
  private readonly providers = new Map<PromptSectionId, SystemPromptSectionProvider>();
  private readonly cacheByThread = new Map<string, CacheEntry>();
  private registryRevision = 0;

  constructor(providers: readonly SystemPromptSectionProvider[] = []) {
    for (const provider of providers) this.register(provider);
    this.registryRevision = 0;
  }

  register(provider: SystemPromptSectionProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new Error(`System prompt section already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
    this.registryRevision += 1;
    this.cacheByThread.clear();
    return () => {
      if (!this.providers.delete(provider.id)) return;
      this.registryRevision += 1;
      this.cacheByThread.clear();
    };
  }

  assemble(context: SystemPromptContext): AssembledSystemPrompt {
    const rendered = [...this.providers.values()]
      .sort((left, right) => left.order - right.order)
      .flatMap((provider): AssembledPromptSection[] => {
        const content = provider.render(context)?.trim();
        return content ? [{ id: provider.id, content, cacheScope: provider.cacheScope }] : [];
      });
    const staticSections = rendered.filter((section) => section.cacheScope === "global");
    const dynamicSections = rendered.filter((section) => section.cacheScope === null);
    const staticPrefix = staticSections.map((section) => section.content).join("\n\n");
    const dynamicSuffix = dynamicSections.map((section) => section.content).join("\n\n");
    const text = dynamicSuffix
      ? `${staticPrefix}${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}${dynamicSuffix}`
      : staticPrefix;
    return {
      sections: [...staticSections, ...dynamicSections],
      text,
      staticPrefix,
      dynamicSuffix,
    };
  }

  get(context: SystemPromptContext, threadId?: string): AssembledSystemPrompt {
    const contextKey = serializeSystemPromptContextKey(context);
    if (threadId) {
      const cached = this.cacheByThread.get(threadId);
      if (cached?.contextKey === contextKey && cached.registryRevision === this.registryRevision) {
        return cached.result;
      }
    }
    const result = this.assemble(context);
    if (threadId) {
      this.cacheByThread.set(threadId, {
        contextKey,
        registryRevision: this.registryRevision,
        result,
      });
    }
    return result;
  }

  clearCache(threadId?: string): void {
    if (threadId) {
      this.cacheByThread.delete(threadId);
      return;
    }
    this.cacheByThread.clear();
  }
}

function definition(id: keyof typeof PROMPT_SECTION_DEFS) {
  return PROMPT_SECTION_DEFS[id]!;
}

const defaultProviders: SystemPromptSectionProvider[] = [
  {
    ...definition("identity"),
    render: () => buildIdentitySection(),
  },
  {
    ...definition("responseProtocol"),
    render: () => buildResponseProtocolSection(),
  },
  {
    ...definition("runtimeContext"),
    render: (context) =>
      buildRuntimeContextSection({
        stage: context.stage,
        requiredOutcome: context.requiredOutcome,
        stepLimits: context.stepLimits,
        enabledTools: context.coreTools,
        pptTaskPlan: context.pptTaskPlan,
      }),
  },
  {
    ...definition("tools"),
    render: (context) =>
      buildToolsSection({
        stage: context.stage,
        enabledTools: context.coreTools,
        skillCatalog: context.skillCatalog,
        skillRegistry: context.skillRegistry,
        pptTaskPlan: context.pptTaskPlan,
      }),
  },
  {
    ...definition("workspace"),
    render: (context) =>
      buildWorkspaceSection({
        stage: context.stage,
        workspaceRoot: context.workspaceRoot,
        currentSlideId: context.currentSlideId,
        artifacts: context.artifacts,
        artifactDetails: context.artifactDetails,
      }),
  },
  {
    ...definition("memory"),
    render: (context) =>
      context.memories.trim() ? buildMemorySection({ memories: context.memories }) : undefined,
  },
];

const defaultManager = new SystemPromptManager(defaultProviders);

export function registerSystemPromptSection(provider: SystemPromptSectionProvider): () => void {
  return defaultManager.register(provider);
}

export function assembleSystemPrompt(context: SystemPromptContext): AssembledSystemPrompt {
  return defaultManager.assemble(context);
}

export function getSystemPrompt(
  context: SystemPromptContext,
  threadId?: string,
): AssembledSystemPrompt {
  return defaultManager.get(context, threadId);
}

/** @returns Section content array (static sections first, then dynamic). */
export function getSystemPromptSections(context: SystemPromptContext, threadId?: string): string[] {
  return getSystemPrompt(context, threadId).sections.map((section) => section.content);
}

export function clearSystemPromptCache(threadId?: string): void {
  defaultManager.clearCache(threadId);
}

export function splitSystemPromptPrefix(text: string): {
  staticPrefix: string;
  dynamicSuffix: string;
} {
  const boundaryIndex = text.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  if (boundaryIndex < 0) {
    return { staticPrefix: text, dynamicSuffix: "" };
  }
  return {
    staticPrefix: text.slice(0, boundaryIndex),
    dynamicSuffix: text.slice(boundaryIndex + SYSTEM_PROMPT_DYNAMIC_BOUNDARY.length),
  };
}
