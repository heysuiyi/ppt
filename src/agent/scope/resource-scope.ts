import { AgentError } from "../protocol-utils";
import type { Disposable } from "../protocol-values";

/** 仅释放显式取得所有权的资源；父信号不代表父服务的所有权。 */
export class ResourceScope implements Disposable {
  private readonly controller = new AbortController();
  private readonly resources = new Set<Disposable>();
  private disposal?: Promise<void>;
  private detachParent?: () => void;
  private detachOwner?: () => void;

  constructor(parentSignal?: AbortSignal) {
    if (parentSignal) {
      const abort = () => this.controller.abort(parentSignal.reason);
      if (parentSignal.aborted) abort();
      else {
        parentSignal.addEventListener("abort", abort, { once: true });
        this.detachParent = () => parentSignal.removeEventListener("abort", abort);
      }
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  own(resource: Disposable): void {
    if (this.disposal || this.signal.aborted) {
      throw new AgentError("scope_closed", "Cannot add resources to a closing scope");
    }
    if (resource === this) throw new AgentError("scope_cycle", "A scope cannot own itself");
    this.resources.add(resource);
  }

  child(): ResourceScope {
    const child = new ResourceScope(this.signal);
    this.own(child);
    child.detachOwner = () => this.resources.delete(child);
    return child;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    // 先发布同一个完成承诺，abort 监听器中的重入也不会重复释放。
    this.disposal = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      const resources = [...this.resources].reverse();
      this.resources.clear();
      try {
        for (const resource of resources) {
          try {
            await resource.dispose();
          } catch (error) {
            errors.push(error);
          }
        }
      } finally {
        this.detachOwner?.();
        this.detachOwner = undefined;
      }
      if (errors.length) throw new AggregateError(errors, "Resource disposal failed");
    });
    this.detachParent?.();
    this.detachParent = undefined;
    this.controller.abort();
    return this.disposal;
  }
}
