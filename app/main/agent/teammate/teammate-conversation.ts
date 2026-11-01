import type {
  AgentModelContentBlock,
  AgentModelMessage,
  AgentModelToolResultBlock,
} from "../gateway";

export class TeammateConversation {
  private readonly transcript: Array<Record<string, unknown>>;
  private readonly modelMessages: AgentModelMessage[];

  constructor(initialPrompt?: string) {
    this.transcript = initialPrompt ? [{ role: "user", content: initialPrompt }] : [];
    this.modelMessages = initialPrompt
      ? [{ role: "user", content: [{ type: "text", text: initialPrompt }] }]
      : [];
  }

  appendUser(content: string, transcriptFields: Record<string, unknown> = {}): void {
    this.transcript.push({ role: "user", content, ...transcriptFields });
    this.modelMessages.push({
      role: "user",
      content: [{ type: "text", text: content }],
    });
  }

  appendAssistant(content: AgentModelContentBlock[], transcriptText?: string): void {
    this.modelMessages.push({ role: "assistant", content });
    if (transcriptText !== undefined) {
      this.transcript.push({ role: "assistant", content: transcriptText });
    }
  }

  appendToolResults(
    transcriptEntries: Array<Record<string, unknown>>,
    results: AgentModelToolResultBlock[],
  ): void {
    this.transcript.push(...transcriptEntries);
    this.modelMessages.push({ role: "user", content: results });
  }

  appendToolTranscript(transcriptEntries: Array<Record<string, unknown>>): void {
    this.transcript.push(...transcriptEntries);
  }

  modelInput(): AgentModelMessage[] {
    return [...this.modelMessages];
  }

  transcriptSnapshot(): Array<Record<string, unknown>> {
    return [...this.transcript];
  }
}
