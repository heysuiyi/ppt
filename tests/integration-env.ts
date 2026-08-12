/** Shared env helpers for `*.integration.test.ts`. Not used by the default unit run. */

export function environment(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export function hasEnvironment(...names: string[]): boolean {
  return names.every((name) => Boolean(environment(name)));
}

export function requiredEnvironment(name: string): string {
  const value = environment(name);
  if (!value) throw new Error(`Missing ${name} in the process environment.`);
  return value;
}

/** Product name is OPENAI_BASE_URL; OPENAI_API_URL is a common local alias. */
export function resolveOpenAiBaseURL(): string | undefined {
  return environment("OPENAI_BASE_URL") ?? environment("OPENAI_API_URL");
}

export function resolveAnthropicBaseURL(): string | undefined {
  return environment("ANTHROPIC_BASE_URL");
}
