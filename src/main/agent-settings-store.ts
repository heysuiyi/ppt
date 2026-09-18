import { readFile } from "node:fs/promises";
import type { AgentModelSelection } from "@shared/agent";
import { type AgentSettings, agentSettingsSchema } from "@shared/agent-settings";
import { writeTextFileAtomic } from "./agent/persistence/atomic-json-file";

/** Main owns execution settings; Renderer only edits a secret-free projection. */
export class AgentSettingsStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async get(): Promise<AgentSettings | undefined> {
    await this.queue;
    try {
      return agentSettingsSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  save(input: unknown, onlyIfMissing = false): Promise<AgentSettings> {
    const settings = agentSettingsSchema.parse(input);
    const operation = this.queue
      .catch(() => undefined)
      .then(async () => {
        if (onlyIfMissing) {
          try {
            return agentSettingsSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        await writeTextFileAtomic(this.path, JSON.stringify(settings));
        return settings;
      });
    this.queue = operation;
    return operation;
  }
}

export function resolveConfiguredModel(
  settings: AgentSettings,
  modelId: string,
): AgentModelSelection {
  for (const vendor of settings.vendors) {
    const model = vendor.models.find((entry) => entry.id === modelId);
    if (!model) continue;
    if (!vendor.enabled || !model.enabled) throw new Error("Selected model is disabled.");
    return {
      configurationId: model.id,
      vendorId: vendor.id,
      provider: vendor.protocol,
      model: model.model,
      baseURL: vendor.baseURL || undefined,
      openaiApiMode: vendor.protocol === "openai" ? model.openaiApiMode : undefined,
      supports1MContext: model.supports1MContext,
    };
  }
  throw new Error("Selected model configuration does not exist.");
}
