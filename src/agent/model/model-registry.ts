import { AgentError, snapshot } from "../protocol-utils";
import type { Disposable } from "../protocol-values";
import { RegistrationStore } from "../scope/registration-store";
import type {
  ModelBinding,
  ModelClientFactory,
  ModelRegistrar,
  ModelSelection,
} from "./model-contract";

export class ModelRegistry implements ModelClientFactory, ModelRegistrar, Disposable {
  private readonly registrations = new RegistrationStore<ModelClientFactory>();

  constructor(private readonly fallback?: ModelClientFactory) {}

  register(providerId: string, factory: ModelClientFactory): Disposable {
    return this.registrations.register(providerId, factory);
  }

  async create(selection: ModelSelection, signal: AbortSignal): Promise<ModelBinding> {
    this.registrations.assertOpen();
    signal.throwIfAborted();
    const selected = snapshot(selection);
    const factory = this.registrations.entries.get(selected.providerId) ?? this.fallback;
    if (!factory) {
      throw new AgentError(
        "model_provider_unavailable",
        `Unknown model provider: ${selected.providerId}`,
      );
    }
    const binding = await factory.create(selected, signal);
    if (signal.aborted) {
      try {
        await binding.dispose();
      } finally {
        signal.throwIfAborted();
      }
    }
    return binding;
  }

  seal(): void {
    this.registrations.seal();
  }

  dispose(): Promise<void> {
    return this.registrations.dispose();
  }
}
