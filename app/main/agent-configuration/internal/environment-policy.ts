import type { AgentProvider } from "@shared/agent";
import { DEFAULT_WEB_SEARCH_ENDPOINT } from "@shared/agent-gateway-config";
import { normalizeCredentialUrl } from "@shared/credentials";

export const OFFICIAL_MODEL_BASE_URLS: Readonly<Record<AgentProvider, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};

export function resolveEnvironmentModelApiKey(
  provider: AgentProvider,
  requestedBaseURL: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const apiKey =
    provider === "openai"
      ? environment.OPENAI_API_KEY?.trim()
      : environment.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return undefined;

  const environmentBaseURL =
    provider === "openai"
      ? environment.OPENAI_BASE_URL?.trim()
      : environment.ANTHROPIC_BASE_URL?.trim();
  return environmentCredentialMatchesRoute(
    requestedBaseURL,
    environmentBaseURL,
    OFFICIAL_MODEL_BASE_URLS[provider],
  )
    ? apiKey
    : undefined;
}

export function resolveEnvironmentWebSearchApiKey(
  requestedEndpoint: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const apiKey = environment.TAVILY_API_KEY?.trim();
  if (!apiKey) return undefined;

  return environmentCredentialMatchesRoute(
    requestedEndpoint,
    environment.TAVILY_SEARCH_ENDPOINT?.trim(),
    DEFAULT_WEB_SEARCH_ENDPOINT,
  )
    ? apiKey
    : undefined;
}

function environmentCredentialMatchesRoute(
  requestedRoute: string | undefined,
  environmentRoute: string | undefined,
  officialRoute: string,
): boolean {
  const normalizedRequested = normalizeRoute(requestedRoute);
  const normalizedEnvironment = normalizeRoute(environmentRoute);
  const normalizedOfficial = normalizeCredentialUrl(officialRoute);

  if (!requestedRoute?.trim()) {
    return !environmentRoute?.trim() || normalizedEnvironment !== undefined;
  }
  if (!normalizedRequested) return false;
  if (normalizedRequested === normalizedOfficial) return true;
  return normalizedEnvironment !== undefined && normalizedRequested === normalizedEnvironment;
}

function normalizeRoute(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    return normalizeCredentialUrl(value);
  } catch {
    return undefined;
  }
}
