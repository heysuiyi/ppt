let defaultsRegistered = false;

/**
 * Register optional default extensions (currently none).
 *
 * Permission is enforced directly at execution boundaries and must never be a
 * removable hook. Keep this lifecycle shim for embedders and tests.
 */
export function ensureDefaultHooks(): void {
  if (defaultsRegistered) return;
  defaultsRegistered = true;
}

/** 仅用于测试：重置默认注册状态。 */
export function resetDefaultHooksForTests(): void {
  defaultsRegistered = false;
}
