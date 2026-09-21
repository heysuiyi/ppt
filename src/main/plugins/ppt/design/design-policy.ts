import type { Presentation } from "@shared/presentation";

export interface DesignPolicyConstraint {
  id: string;
  name: string;
  validate: (before: Presentation, after: Presentation) => { valid: boolean; message?: string };
}

/**
 * 跨工具共享的视觉设计约束政策定义。
 *
 * SVG-native 工作流不再对 element-IR 做语义保持校验。
 * 保留框架以便后续添加 DesignSystem 级约束。
 */
export class DesignPolicy {
  private readonly constraints: DesignPolicyConstraint[] = [];

  validate(before: Presentation, after: Presentation): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    for (const rule of this.constraints) {
      const res = rule.validate(before, after);
      if (!res.valid && res.message) {
        errors.push(`[${rule.name}] ${res.message}`);
      }
    }
    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
