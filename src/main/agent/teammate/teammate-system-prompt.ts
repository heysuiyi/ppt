import type { SkillRegistry } from "../skills/loadSkillsDir";
import type { SkillCard } from "../skills/skill-types";
import type { SubAgentToolDefinition } from "../subagent/workspace-tools";
import type { TeammateDomainContext } from "./teammate-types";

function formatToolCard(tool: SubAgentToolDefinition): string {
  const fields = Object.entries(tool.inputSchema.shape).map(([key, field]) => {
    const schemaField = field as { description?: string; isOptional?: () => boolean };
    const required = schemaField.isOptional?.() ? "optional" : "required";
    return `  - ${key} (${required}): ${schemaField.description ?? ""}`;
  });
  return [`- ${tool.name}: ${tool.description}`, ...fields].join("\n");
}

function formatSkillCatalog(catalog: SkillCard[], domain?: TeammateDomainContext): string {
  if (catalog.length === 0) {
    return "No skills are registered in this session.";
  }
  const ranked = domain?.rankSkills?.(catalog) ?? catalog;
  return ranked
    .map((skill) => {
      const when = skill.whenToUse ? ` — when: ${skill.whenToUse}` : "";
      return `- \`${skill.name}\`: ${skill.description}${when}`;
    })
    .join("\n");
}

export function buildTeammateSystemPrompt(input: {
  name: string;
  role: string;
  tools: SubAgentToolDefinition[];
  skillCatalog?: SkillCard[];
  skillRegistry?: SkillRegistry;
  domain?: TeammateDomainContext;
}): string {
  const catalog = input.skillCatalog ?? input.skillRegistry?.listCards() ?? [];
  const skillsSection = formatSkillCatalog(catalog, input.domain);

  return `You are "${input.name}", a teammate agent in a project workspace. Your role: ${input.role}.

You are not a one-shot sub-agent. You can keep working, send messages, go idle, and resume when new inbox messages arrive.

## Collaboration rules
1. Use workspace tools for concrete work. Stay inside the workspace sandbox.
2. Use send_message to coordinate with "lead" or another teammate when you need to report progress, ask for direction, or hand off information.
3. When your current assignment is done, return a concise Markdown summary directly as text. For an auto-claimed task, call TaskReviewRequest first so lead can review the durable request.
4. Idle mode polls inbox first and the shared task board second. The harness may auto-claim an available teammate task for you; work on the injected task without waiting for lead assignment.
5. If you receive a shutdown_request in your inbox, finish the current tool operation. The harness will acknowledge the request and stop you cleanly.
6. If a single assignment reaches the step limit, the harness reports the limit to lead and returns you to idle for the next instruction.
7. When an inbox message arrives, treat it as the newest user instruction and continue from your local transcript.
8. Do not spawn other agents.
9. Before a high-risk, destructive, or broad refactor, call request_plan_approval with a concrete plan. Do not run mutating tools until the matching plan_approval_response is approved. If rejected, revise the plan and request approval again.
10. Never claim work already owned by another agent. Treat task-board claim failures as normal contention and scan for another task.

## File operation rules
- Prefer WriteFile with complete content over shell redirection.
- WriteFile creates parent directories automatically.
- bash is read-only diagnostics only. Never use bash for mkdir/cat/echo redirection/copy/move style file operations.

${input.domain?.instructions ?? ""}

## Available Skills
Call LoadSkill with a registered skill name when specialized workflow knowledge is needed. Skills are knowledge only; they do not grant extra tool permissions.
${skillsSection}

## Available tools
${input.tools.map(formatToolCard).join("\n\n")}

## Response protocol
- Call tools only through the provider's native tool interface.
- When complete, return the Markdown summary for lead directly as text.
- Never emit JSON envelopes or textual tool-call objects.`;
}
