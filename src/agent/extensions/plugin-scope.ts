import type { Disposable } from "../protocol-values";

/** Ownership boundary for one plugin activation; not a permission or process sandbox. */
export interface PluginScope extends Disposable {
  readonly signal: AbortSignal;
  /**
   * Adopt one resource. Reject adoption after disposal begins.
   * Teardown aborts the signal, drains owned work and disposes resources in reverse order.
   * Continue cleanup after an individual disposer fails; report failures after all resources settle.
   */
  own(resource: Disposable): void;
}
