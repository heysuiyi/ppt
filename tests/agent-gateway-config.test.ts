import { describe, expect, it } from "vitest";
import {
  resolveAgentGatewayConfig,
  resolveAgentGatewayPreferences,
  resolveAgentSearchConfig,
} from "../src/shared/agent-gateway-config";

describe("agent runtime parameter validation", () => {
  it.each([0, -1, 1.5, Number.NaN])("rejects invalid timeout %s", (timeoutMs) => {
    expect(() => resolveAgentGatewayConfig({ timeoutMs })).toThrow();
    expect(() => resolveAgentGatewayPreferences({ timeoutMs })).toThrow();
  });

  it.each([0, -1, 1.5])("rejects invalid output limit %s", (maxOutputTokens) => {
    expect(() => resolveAgentGatewayConfig({ maxOutputTokens })).toThrow();
  });

  it("rejects a malformed fallback model rather than deferring invalid identity to a driver", () => {
    expect(() =>
      resolveAgentGatewayConfig({
        fallbackModel: { provider: "openai", model: " " },
      }),
    ).toThrow();
  });

  it("rejects a non-positive search timeout", () => {
    expect(() => resolveAgentSearchConfig({ webSearchTimeoutMs: 0 })).toThrow();
  });
});
