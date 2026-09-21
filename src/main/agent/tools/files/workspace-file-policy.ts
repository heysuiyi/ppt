import type { WorkspaceFileService } from "./workspace-file-service";

/** Domain checks run inside the shared file pipeline, without replacing its safety checks. */
export interface WorkspaceFilePolicy {
  requiresContentValidation(path: string): boolean;
  validateContent(path: string, content: string, service: WorkspaceFileService): Promise<void>;
  observe?(input: {
    workspaceRoot: string;
    paths: readonly string[];
    source: "capability_probe" | "agent_read" | "agent_write";
  }): Promise<void>;
}
