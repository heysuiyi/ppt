import type { AgentExecutionStrategy } from "@agent-harness/configuration/model-contract";
import type { AgentStepLimits } from "@agent-harness/configuration/step-limits";
import { Select } from "../Select";
import { Switch } from "../Switch";
import { RangeField, SettingsPanel, SettingsRow, SettingsSection } from "./SettingsPrimitives";

export function AgentBehaviorSettingsPanel({
  executionStrategy,
  setExecutionStrategy,
  limits,
  setLimits,
}: {
  executionStrategy: AgentExecutionStrategy;
  setExecutionStrategy: (value: AgentExecutionStrategy) => void;
  limits: AgentStepLimits;
  setLimits: (value: AgentStepLimits) => void;
}) {
  return (
    <SettingsPanel>
      <SettingsSection title="提交审批">
        <SettingsRow label="审批模式">
          <Select
            variant="settings"
            ariaLabel="审批模式"
            value={executionStrategy}
            onChange={(next) => setExecutionStrategy(next as AgentExecutionStrategy)}
            options={[
              { value: "REQUEST_APPROVAL", label: "手动确认每次修改" },
              { value: "AUTO", label: "自动应用低风险修改" },
            ]}
          />
        </SettingsRow>
        <p className="settings-hint">
          自动模式仅直接应用低风险提案；中高风险修改仍由 CommitGate 请求确认。
        </p>
      </SettingsSection>

      <SettingsSection title="单次步数上限">
        <SettingsRow label="启用步数上限">
          <Switch
            label="启用步数上限"
            checked={limits.enabled}
            onChange={(event) => setLimits({ ...limits, enabled: event.target.checked })}
          />
        </SettingsRow>
        <SettingsRow label="主 Agent 单次上限" muted={!limits.enabled}>
          <RangeField
            valueLabel={`${limits.mainMaxSteps} 次`}
            min="8"
            max="80"
            step="1"
            value={limits.mainMaxSteps}
            disabled={!limits.enabled}
            onChange={(event) =>
              setLimits({
                ...limits,
                mainMaxSteps: parseInt(event.target.value, 10),
              })
            }
          />
        </SettingsRow>
        <SettingsRow label="子 Agent 单次上限" muted={!limits.enabled}>
          <RangeField
            valueLabel={`${limits.subMaxSteps} 次`}
            min="4"
            max="40"
            step="1"
            value={limits.subMaxSteps}
            disabled={!limits.enabled}
            onChange={(event) =>
              setLimits({
                ...limits,
                subMaxSteps: parseInt(event.target.value, 10),
              })
            }
          />
        </SettingsRow>
      </SettingsSection>
    </SettingsPanel>
  );
}
