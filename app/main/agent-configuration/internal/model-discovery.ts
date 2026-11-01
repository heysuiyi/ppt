import type { ModelAdapterId, ModelProvider } from "@agent-harness/models/model-contract";
import { getModelProfile } from "@agent-harness/models/model-profiles";
import { createModelProvider } from "@agent-harness/models/models";
import Anthropic from "@anthropic-ai/sdk";
import type { AgentProvider } from "@shared/agent";
import type { ListRemoteModelsResult, RemoteModelInfo } from "@shared/remote-models";
import OpenAI from "openai";

const LIST_TIMEOUT_MS = 20_000;
const MAX_MODELS = 2_000;

class ListRemoteModelsError extends Error {
  readonly code = "provider-error";

  constructor(message: string) {
    super(message);
    this.name = "ListRemoteModelsError";
  }
}

function uniqueSortedModels(models: RemoteModelInfo[]): RemoteModelInfo[] {
  const byId = new Map<string, RemoteModelInfo>();
  for (const model of models) {
    const id = model.id.trim();
    if (!id) continue;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, {
        id,
        ...(model.displayName?.trim() ? { displayName: model.displayName.trim() } : {}),
      });
      continue;
    }
    if (!existing.displayName && model.displayName?.trim()) {
      byId.set(id, { id, displayName: model.displayName.trim() });
    }
  }
  return [...byId.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, MAX_MODELS);
}

async function listOpenAICompatibleModels(
  apiKey: string,
  baseURL: string,
): Promise<RemoteModelInfo[]> {
  const client = new OpenAI({
    apiKey,
    baseURL,
    timeout: LIST_TIMEOUT_MS,
    maxRetries: 0,
  });

  const models: RemoteModelInfo[] = [];
  try {
    for await (const model of client.models.list()) {
      if (typeof model.id !== "string" || !model.id.trim()) continue;
      models.push({ id: model.id.trim() });
      if (models.length >= MAX_MODELS) break;
    }
  } catch {
    throw new ListRemoteModelsError("Failed to list OpenAI-compatible models.");
  }
  return uniqueSortedModels(models);
}

async function listAnthropicCompatibleModels(
  apiKey: string,
  baseURL: string,
): Promise<RemoteModelInfo[]> {
  const client = new Anthropic({
    apiKey,
    baseURL,
    timeout: LIST_TIMEOUT_MS,
    maxRetries: 0,
  });

  const models: RemoteModelInfo[] = [];
  try {
    for await (const model of client.models.list({ limit: 1000 })) {
      if (typeof model.id !== "string" || !model.id.trim()) continue;
      const displayName =
        typeof model.display_name === "string" && model.display_name.trim()
          ? model.display_name.trim()
          : undefined;
      models.push({
        id: model.id.trim(),
        ...(displayName ? { displayName } : {}),
      });
      if (models.length >= MAX_MODELS) break;
    }
  } catch {
    throw new ListRemoteModelsError("Failed to list Anthropic-compatible models.");
  }
  return uniqueSortedModels(models);
}

export async function listProviderModels(
  provider: Pick<ModelProvider, "discovery">,
  signal: AbortSignal,
): Promise<ListRemoteModelsResult> {
  if (!provider.discovery)
    throw new ListRemoteModelsError("This model adapter does not support model discovery.");
  const models = await provider.discovery.listModels(signal);
  return { models: models.map((model) => ({ ...model })) };
}

export async function discoverModels(request: {
  provider: AgentProvider;
  baseURL: string;
  apiKey: string;
  modelAdapter?: ModelAdapterId;
}): Promise<ListRemoteModelsResult> {
  if (request.modelAdapter !== undefined) {
    const profile = getModelProfile(request.modelAdapter);
    if (
      profile?.protocol !== "openai-responses" ||
      profile.endpoint?.kind !== "fixed" ||
      request.provider !== "openai" ||
      request.baseURL !== profile.endpoint.url
    )
      throw new ListRemoteModelsError("Invalid MiMo Token Plan CN connection.");
    const signal = new AbortController().signal;
    const provider = await createModelProvider(
      {
        adapterId: profile.adapterId,
        apiKey: request.apiKey,
        connectionFingerprint: profile.adapterId,
        timeoutMs: LIST_TIMEOUT_MS,
        maxOutputTokens: 16_384,
      },
      signal,
    );
    try {
      signal.throwIfAborted();
      return await listProviderModels(provider, signal);
    } finally {
      await provider.dispose();
    }
  }
  const models =
    request.provider === "openai"
      ? await listOpenAICompatibleModels(request.apiKey, request.baseURL)
      : await listAnthropicCompatibleModels(request.apiKey, request.baseURL);
  return { models };
}
