import {
  executeCommand,
  type PresentationCommand,
  presentationCommandSchema,
} from "@shared/commands";
import type { DeckValidationIssue } from "@shared/deck-validation";
import type { Presentation } from "@shared/presentation";
import {
  type DeckValidationService,
  deckValidationService,
} from "../../../../ppt/core/deck-validation-service";
import { DesignPolicy } from "../design/design-policy";
import { type PresentationDiff, PresentationDiffGenerator } from "./presentation-diff";
import type { RiskPolicy } from "./risk-policy";

export interface CommitGateResult {
  success: boolean;
  errors: string[];
  warnings?: string[];
  diff?: PresentationDiff;
  risk: "low" | "medium" | "high";
  decision: "AUTO" | "REQUIRES_APPROVAL" | "REJECT";
  preview?: Presentation;
}

/**
 * 所有真实 Presentation 修改前的安全闸门。
 *
 * 负责命令 schema 校验、基于快照的沙箱试运行、before/after preview、diff 摘要，
 * 并调用风险策略决定自动应用、请求审批、退回 Runtime 修正或失败。
 *
 * 这是 command_proposal 提交前不可跳过的最终系统校验。无论模型是否调用过
 * PreviewCommands，都必须从当前真实快照重新执行完整校验，不能信任或复用模型侧
 * 的预览结论。两者可以共享底层纯沙箱函数，但不能共享校验责任或跳过本闸门。
 */
export class CommitGate {
  constructor(
    private readonly riskPolicy: RiskPolicy,
    private readonly designPolicy: DesignPolicy = new DesignPolicy(),
    private readonly deckValidation: DeckValidationService = deckValidationService,
  ) {}

  /**
   * 对命令提案进行系统关闸级校验、沙箱执行、Diff 生成和风险评估。
   */
  async evaluate(
    presentation: Presentation,
    commands: PresentationCommand[],
    modelReportedRisk: "low" | "medium" | "high",
    options: { workspaceRoot?: string } = {},
  ): Promise<CommitGateResult> {
    const errors: string[] = [];
    let stagedPresentation = structuredClone(presentation);

    // 1. 命令基本校验与沙箱试运行
    for (const cmd of commands) {
      const parseResult = presentationCommandSchema.safeParse(cmd);
      if (!parseResult.success) {
        errors.push(`Schema validation failed: ${parseResult.error.message}`);
        continue;
      }

      try {
        const result = executeCommand(stagedPresentation, parseResult.data);
        stagedPresentation = result.presentation;
      } catch (err) {
        errors.push(
          `Execution failed for command type '${cmd.type}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (errors.length > 0) {
      return {
        success: false,
        errors,
        risk: "high",
        decision: "REJECT",
      };
    }

    // 2. 生成 Diff 差异摘要
    const diff = PresentationDiffGenerator.generate(presentation, stagedPresentation);

    // 3. 强制执行语义与 deck 校验。只拒绝本次修改新增的 error，
    // 避免历史遗留问题阻断无关修复；新增 warning 会强制进入审批。
    const semanticResult = this.designPolicy.validate(presentation, stagedPresentation);
    if (!semanticResult.valid) {
      return {
        success: false,
        errors: semanticResult.errors,
        warnings: [],
        diff,
        risk: "high",
        decision: "REJECT",
        preview: stagedPresentation,
      };
    }

    const affectedSlideIds = diff.affectedSlideIds;
    const beforeValidation = this.deckValidation.validate(presentation, {
      slideIds: affectedSlideIds,
      workspaceRoot: options.workspaceRoot,
    });
    const afterValidation = this.deckValidation.validate(stagedPresentation, {
      slideIds: affectedSlideIds,
      workspaceRoot: options.workspaceRoot,
    });
    const beforeIssueKeys = new Set(
      beforeValidation.issues.map((issue) => validationIssueKey(issue, presentation)),
    );
    const newValidationIssues = afterValidation.issues.filter(
      (issue) => !beforeIssueKeys.has(validationIssueKey(issue, stagedPresentation)),
    );
    const validationErrors = newValidationIssues
      .filter((issue) => issue.severity === "error")
      .map(formatValidationIssue);
    const validationWarnings = newValidationIssues
      .filter((issue) => issue.severity !== "error")
      .map(formatValidationIssue);

    if (validationErrors.length > 0) {
      return {
        success: false,
        errors: validationErrors,
        warnings: validationWarnings,
        diff,
        risk: "high",
        decision: "REJECT",
        preview: stagedPresentation,
      };
    }

    // 4. 计算系统判定风险与决定
    const riskResult = this.riskPolicy.evaluate({
      commands,
      diff,
      modelReportedRisk:
        validationWarnings.length > 0 ? higherRisk(modelReportedRisk, "medium") : modelReportedRisk,
    });

    return {
      success: true,
      errors: [],
      warnings: validationWarnings,
      diff,
      risk: riskResult.risk,
      decision: riskResult.decision,
      preview: stagedPresentation,
    };
  }
}

function higherRisk(
  left: "low" | "medium" | "high",
  right: "low" | "medium" | "high",
): "low" | "medium" | "high" {
  const order = { low: 0, medium: 1, high: 2 } as const;
  return order[left] >= order[right] ? left : right;
}

function validationIssueKey(issue: DeckValidationIssue, presentation: Presentation): string {
  const slideTitle = issue.slideId
    ? presentation.slides.find((slide) => slide.id === issue.slideId)?.title
    : undefined;
  const normalizedMessage = slideTitle
    ? issue.message.replaceAll(`'${slideTitle}'`, "'<slide>'")
    : issue.message;
  return [
    issue.category,
    issue.severity,
    issue.slideId ?? "",
    normalizedMessage,
    issue.fixHint ?? "",
  ].join("|");
}

function formatValidationIssue(issue: DeckValidationIssue): string {
  const location = issue.slideId ? `Slide '${issue.slideId}': ` : "";
  return `${location}${issue.message}${issue.fixHint ? ` Fix: ${issue.fixHint}` : ""}`;
}
