import type { Disposable } from "../protocol-values.js";
import { RegistrationStore } from "../scope/registration-store.js";
import type { PromptContext, PromptContribution, PromptRegistrar } from "./plugin-contract.js";

export class PromptRegistry implements PromptRegistrar, Disposable {
  private readonly registrations = new RegistrationStore<PromptContribution>();

  register(contribution: PromptContribution): Disposable {
    const entry = { id: contribution.id, render: contribution.render.bind(contribution) };
    return this.registrations.register(entry.id, entry);
  }

  async render(context: PromptContext): Promise<string> {
    this.registrations.assertOpen();
    const contributions = [...this.registrations.entries.values()];
    const parts: string[] = [];
    for (const contribution of contributions) {
      context.signal.throwIfAborted();
      parts.push(await contribution.render(context));
    }
    context.signal.throwIfAborted();
    return parts.join("\n\n");
  }

  seal(): void {
    this.registrations.seal();
  }

  dispose(): Promise<void> {
    return this.registrations.dispose();
  }
}
