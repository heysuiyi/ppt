import type { PresentationCommand } from "@shared/commands";
import type { PresentationDiff } from "./presentation-diff";

export interface RiskEvaluationInput {
  commands: PresentationCommand[];
  diff: PresentationDiff;
  modelReportedRisk: "low" | "medium" | "high";
}

export interface RiskPolicyResult {
  risk: "low" | "medium" | "high";
  decision: "AUTO" | "REQUIRES_APPROVAL" | "REJECT";
}

/**
 * 命令方案风险等级的系统评估与判定边界。
 */
export class RiskPolicy {
  evaluate(input: RiskEvaluationInput): RiskPolicyResult {
    let assessedRisk: "low" | "medium" | "high" = "low";

    for (const cmd of input.commands) {
      if (cmd.type === "remove-slide" || cmd.type === "set-design-system") {
        assessedRisk = "high";
      } else if (cmd.type === "restore-slide") {
        if (assessedRisk !== "high") {
          assessedRisk = "medium";
        }
      }
    }

    const affectedCount = input.diff.affectedSlideIds.length;
    if (affectedCount > 3 || input.diff.slidesRemovedCount > 0) {
      assessedRisk = "high";
    } else if (affectedCount > 1) {
      if (assessedRisk !== "high") {
        assessedRisk = "medium";
      }
    }

    const severityMap = { low: 0, medium: 1, high: 2 };
    const systemSeverity = severityMap[assessedRisk];
    const modelSeverity = severityMap[input.modelReportedRisk];

    const finalRisk = systemSeverity >= modelSeverity ? assessedRisk : input.modelReportedRisk;

    const decision =
      finalRisk === "high" || finalRisk === "medium"
        ? ("REQUIRES_APPROVAL" as const)
        : ("AUTO" as const);

    return {
      risk: finalRisk,
      decision,
    };
  }
}
