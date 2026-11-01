import type { DriverResolvedConfig } from "./config";
import type { AgentModelResponse, AgentModelStreamChunk, PreparedAgentModelRequest } from "./types";

/** Provider driver contract consumed exclusively by AgentGateway. */
export interface AgentProviderDriver {
  generate(
    config: DriverResolvedConfig,
    request: PreparedAgentModelRequest,
  ): Promise<AgentModelResponse>;

  generateStream(
    config: DriverResolvedConfig,
    request: PreparedAgentModelRequest,
  ): AsyncGenerator<AgentModelStreamChunk>;
}
