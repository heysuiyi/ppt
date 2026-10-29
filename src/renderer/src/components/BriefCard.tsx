import {
  NARRATIVE_MODE_LABELS,
  RESTRUCTURE_PERMISSION_LABELS,
} from "@shared/commercial-communication";
import type { BriefFields } from "@shared/project-artifacts";
import type React from "react";
import { ArtifactCard, CardHeader } from "./ArtifactCard";

interface BriefCardProps {
  fields: BriefFields;
}

const FIELD_LABELS: Array<{ key: keyof BriefFields; label: string }> = [
  { key: "title", label: "项目名称" },
  { key: "objective", label: "核心目的" },
  { key: "audience", label: "目标听众" },
  { key: "coreMessage", label: "核心信息" },
  { key: "presentationContext", label: "演示场景" },
  { key: "desiredAction", label: "期望行动" },
  { key: "afterUse", label: "使用方式" },
  { key: "restructurePermission", label: "内容重构" },
  { key: "narrativeMode", label: "叙事模式" },
  { key: "duration", label: "演讲时长" },
  { key: "style", label: "期望风格" },
];

export const BriefCard: React.FC<BriefCardProps> = ({ fields }) => (
  <ArtifactCard className="brief-card">
    <CardHeader badge="需求简报" title="需求简报摘要" />

    <dl className="brief-card-fields">
      {FIELD_LABELS.map(({ key, label }) => (
        <div key={key} className="brief-card-field">
          <dt>{label}</dt>
          <dd>
            {key === "restructurePermission"
              ? RESTRUCTURE_PERMISSION_LABELS[fields.restructurePermission]
              : key === "narrativeMode"
                ? NARRATIVE_MODE_LABELS[fields.narrativeMode]
                : fields[key]}
          </dd>
        </div>
      ))}
    </dl>
  </ArtifactCard>
);
