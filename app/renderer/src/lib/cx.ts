/**
 * Tiny className helper — joins truthy string values.
 * Prefer over template-literal soup for state modifiers (`is-active`, etc.).
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  let result = "";
  for (const part of parts) {
    if (!part) continue;
    if (result) result += " ";
    result += part;
  }
  return result;
}
