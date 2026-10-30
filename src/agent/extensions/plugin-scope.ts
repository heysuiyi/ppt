import type { Disposable } from "../protocol-values";

/** 一次插件激活的所有权边界；不是权限或进程沙箱。 */
export interface PluginScope extends Disposable {
  readonly signal: AbortSignal;
  /**
   * 接管一个资源。释放开始后拒绝接管。
   * 拆卸会中止信号、排空所拥有的工作，并按逆序释放资源。
   * 单个释放器失败后继续清理；在所有资源落定后报告失败。
   */
  own(resource: Disposable): void;
}
