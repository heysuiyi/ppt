import { describe, expect, it } from "vitest";
import { DEFAULT_DESIGN_SYSTEM } from "../src/design-system";
import { assertDesignSpecMatchesTemplateState } from "../src/main/plugins/ppt/tools/project-template-state";
import {
  getBuiltinTemplate,
  listAutoPoolTemplates,
  listBuiltinTemplates,
} from "../src/shared/template-catalog";
import {
  projectDesignReferenceGuidance,
  projectDesignReferenceToDesignSystem,
} from "../src/shared/template-projection";
import type { TemplateInspection } from "../src/shared/template-protocol";
import {
  APPLICATION_DEFAULT_TEMPLATE_ID,
  createDefaultProjectTemplatePolicy,
  projectTemplatePolicySchema,
  resolvedTemplateSelectionSchema,
  type TemplateDescriptor,
} from "../src/shared/template-protocol";
import { resolveProjectTemplate } from "../src/shared/template-resolver";

describe("template catalog", () => {
  it("exposes an auto pool of 6–8 builtins and a default fallback", () => {
    const auto = listAutoPoolTemplates();
    expect(auto.length).toBeGreaterThanOrEqual(6);
    expect(auto.length).toBeLessThanOrEqual(8);
    expect(getBuiltinTemplate(APPLICATION_DEFAULT_TEMPLATE_ID)?.fallbackEligible).toBe(true);
    expect(listBuiltinTemplates().length).toBeGreaterThanOrEqual(auto.length);
  });
});

describe("template resolver", () => {
  it("uses project default when policy mode is default", () => {
    const policy = createDefaultProjectTemplatePolicy();
    policy.mode = "default";
    const result = resolveProjectTemplate({ policy });
    expect(result.selection.templateId).toBe(APPLICATION_DEFAULT_TEMPLATE_ID);
    expect(result.selection.source).toBe("fallback");
  });

  it("honors explicit visual style over auto matching", () => {
    const result = resolveProjectTemplate({
      policy: createDefaultProjectTemplatePolicy(),
      signals: {
        explicitVisualStyle: "data-journalism",
        audience: "高管",
        objective: "战略决策",
      },
    });
    expect(result.selection.source).toBe("explicit-builtin");
    expect(result.template.designSystem.visualStyle).toBe("data-journalism");
    expect(resolvedTemplateSelectionSchema.parse(result.selection).supportLevel).toBe("native");
  });

  it("auto-selects tech templates for engineering signals", () => {
    const result = resolveProjectTemplate({
      policy: createDefaultProjectTemplatePolicy(),
      signals: {
        audience: "工程师与架构师",
        objective: "讲解系统架构与平台技术路线",
        deliveryContext: "技术评审",
        topics: ["架构", "工程", "平台"],
      },
    });
    expect(result.scores[0]?.templateId).toMatch(/dark-tech|blueprint/);
    if (result.selection.source === "auto") {
      expect(["builtin/dark-tech", "builtin/blueprint"]).toContain(result.selection.templateId);
    } else {
      expect(result.selection.source).toBe("fallback");
      expect(result.selection.templateId).toBe(APPLICATION_DEFAULT_TEMPLATE_ID);
    }
  });

  it("fails hard when custom uploaded template is missing", () => {
    const policy = projectTemplatePolicySchema.parse({
      version: 1,
      mode: "custom",
      defaultTemplateId: APPLICATION_DEFAULT_TEMPLATE_ID,
      customTemplateId: "uploaded/missing",
      customTemplateRevisionId: "deadbeef",
    });
    expect(() => resolveProjectTemplate({ policy, uploadedTemplates: [] })).toThrow(
      /mode=custom pins uploaded\/missing@deadbeef/,
    );
  });

  it("is deterministic for the same inputs", () => {
    const input = {
      policy: createDefaultProjectTemplatePolicy(),
      signals: {
        audience: "投资人",
        objective: "财务与数据分析汇报",
        deliveryContext: "异步近读",
        topics: ["财务", "数据", "指标"],
      },
    };
    const first = resolveProjectTemplate(input);
    const second = resolveProjectTemplate(input);
    expect(first.selection).toEqual(second.selection);
  });
});

describe("design-reference projection", () => {
  it("projects theme colors into a custom design system without master claims", () => {
    const inspection: TemplateInspection = {
      version: 1,
      packageKind: "pptx",
      contentHash: `sha256:${"ab".repeat(32)}`,
      byteLength: 1024,
      importedAt: new Date().toISOString(),
      slideSize: { aspectRatio: "16:9" },
      themeColors: {
        dk1: "111111",
        lt1: "FFFFFF",
        accent1: "1D4ED8",
        accent2: "F59E0B",
        accent3: "0EA5E9",
        lt2: "F8FAFC",
      },
      fonts: { major: "Arial", minor: "Calibri", used: ["Arial", "Calibri"] },
      masters: [{ name: "Office Theme", layoutCount: 11 }],
      layouts: [{ name: "Title Slide", placeholderCount: 2 }],
      sampleSlideCount: 3,
      warnings: [],
      supportLevel: "design-reference",
    };
    const system = projectDesignReferenceToDesignSystem(inspection);
    expect(system.version).toBe(2);
    expect(typeof system.colorScheme === "object").toBe(true);
    const guidance = projectDesignReferenceGuidance(inspection);
    expect(guidance.composition).toMatch(/design-reference/i);
    expect(guidance.avoid.some((item) => /master|placeholder/i.test(item))).toBe(true);
  });
});

describe("design-spec template binding", () => {
  const uploaded: TemplateDescriptor = {
    id: "uploaded/brand-kit",
    revisionId: "abc123",
    kind: "uploaded",
    supportLevel: "design-reference",
    name: "Brand Kit",
    description: "Imported design reference",
    designSystem: {
      version: 2,
      argumentMode: "pyramid",
      visualStyle: "swiss-minimal",
      colorScheme: {
        name: "imported-reference",
        background: "#ffffff",
        secondaryBg: "#f8fafc",
        primary: "#1d4ed8",
        accent: "#f59e0b",
        secondaryAccent: "#0ea5e9",
        bodyText: "#111111",
      },
      readingMode: "balanced",
    },
    matching: {
      topics: ["brand"],
      audiences: ["客户"],
      deliveryContexts: ["路演"],
      argumentModes: ["pyramid"],
      readingModes: ["balanced"],
      density: ["standard"],
      capabilities: ["image"],
    },
    source: {
      originalFileName: "brand.pptx",
      contentHash: `sha256:${"ab".repeat(32)}`,
      sourcePath: "design/templates/uploaded-brand-kit/abc123/source.pptx",
      importedAt: new Date().toISOString(),
      packageKind: "pptx",
      byteLength: 2048,
    },
  };

  it("rejects design-spec that omits the custom-bound uploaded template", () => {
    expect(() =>
      assertDesignSpecMatchesTemplateState(
        {
          policy: projectTemplatePolicySchema.parse({
            version: 1,
            mode: "custom",
            defaultTemplateId: APPLICATION_DEFAULT_TEMPLATE_ID,
            customTemplateId: uploaded.id,
            customTemplateRevisionId: uploaded.revisionId,
          }),
          uploadedTemplates: [uploaded],
        },
        {
          presentationDesignSystem: DEFAULT_DESIGN_SYSTEM,
        },
      ),
    ).toThrow(/pins template/);
  });

  it("rejects design-spec that keeps the builtin palette after a custom import", () => {
    expect(() =>
      assertDesignSpecMatchesTemplateState(
        {
          policy: projectTemplatePolicySchema.parse({
            version: 1,
            mode: "custom",
            defaultTemplateId: APPLICATION_DEFAULT_TEMPLATE_ID,
            customTemplateId: uploaded.id,
            customTemplateRevisionId: uploaded.revisionId,
          }),
          uploadedTemplates: [uploaded],
        },
        {
          presentationDesignSystem: DEFAULT_DESIGN_SYSTEM,
          resolvedTemplate: {
            templateId: uploaded.id,
            templateRevisionId: uploaded.revisionId,
            source: "explicit-custom",
            reasons: ["test"],
            supportLevel: "design-reference",
          },
        },
      ),
    ).toThrow(/colorScheme must be the palette extracted/);
  });

  it("accepts design-spec copied from the uploaded ResolveProjectTemplate result", () => {
    expect(() =>
      assertDesignSpecMatchesTemplateState(
        {
          policy: projectTemplatePolicySchema.parse({
            version: 1,
            mode: "custom",
            defaultTemplateId: APPLICATION_DEFAULT_TEMPLATE_ID,
            customTemplateId: uploaded.id,
            customTemplateRevisionId: uploaded.revisionId,
          }),
          uploadedTemplates: [uploaded],
        },
        {
          presentationDesignSystem: uploaded.designSystem,
          resolvedTemplate: {
            templateId: uploaded.id,
            templateRevisionId: uploaded.revisionId,
            source: "explicit-custom",
            reasons: ["Project policy mode=custom"],
            supportLevel: "design-reference",
          },
        },
      ),
    ).not.toThrow();
  });
});
