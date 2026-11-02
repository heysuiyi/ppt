import type { HostOpenOptions, NodeHost } from "./host-contract.js";

/** Borrows the terminal controller's single input owner. */
export interface TerminalSetupIO {
  select(
    title: string,
    items: readonly { readonly id: string; readonly label: string }[],
  ): Promise<string | undefined>;
  secret(prompt: string): Promise<string | undefined>;
  text(prompt: string): Promise<string | undefined>;
  notify(message: string): Promise<void>;
}

export type TerminalConnectionTarget =
  | { readonly type: "existing"; readonly vendorId: string }
  | {
      readonly type: "new";
      readonly adapterId:
        | "mimo-token-plan-cn"
        | "openai-responses"
        | "openai-chat-completions"
        | "anthropic-messages";
    };

export interface TerminalConnectionItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly target: TerminalConnectionTarget;
}

export interface TerminalHostOpenOptions extends HostOpenOptions {
  readonly setup?: TerminalSetupIO;
}

export interface TerminalHost extends NodeHost {
  open(options: TerminalHostOpenOptions): Promise<void>;
  connections(): Promise<readonly TerminalConnectionItem[]>;
  configureModel(
    setup: TerminalSetupIO,
    target?: TerminalConnectionTarget,
  ): Promise<string | undefined>;
}

export interface TerminalHostOptions {
  readonly dataRoot: string;
  readonly workspaceRoot: string;
}
