import { AgentError } from "../protocol-errors";
import type { Disposable } from "../protocol-values";

/** 注册句柄绑定条目身份；旧句柄不能移除同名的新注册。 */
export class RegistrationStore<T> implements Disposable {
  readonly entries = new Map<string, T>();
  private sealed = false;
  private closed = false;

  register(key: string, value: T): Disposable {
    if (this.closed || this.sealed) {
      throw new AgentError("registry_closed", "Registry no longer accepts registrations");
    }
    if (this.entries.has(key)) {
      throw new AgentError("duplicate_registration", `Duplicate registration: ${key}`);
    }
    this.entries.set(key, value);
    let removed = false;
    return {
      dispose: async () => {
        if (removed) return;
        removed = true;
        if (this.entries.get(key) === value) this.entries.delete(key);
      },
    };
  }

  assertOpen(): void {
    if (this.closed) throw new AgentError("registry_closed", "Registry is disposed");
  }

  seal(): void {
    this.assertOpen();
    this.sealed = true;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.entries.clear();
  }
}
