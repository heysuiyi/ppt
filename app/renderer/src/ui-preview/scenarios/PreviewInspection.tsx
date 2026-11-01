import type { Dispatch } from "react";
import { Button } from "../../ui/components/button/Button";
import { Select } from "../../ui/components/select/Select";
import type { UiTheme } from "../../ui/provider/UiProvider";
import type { ConnectionAction, ConnectionState } from "../state/connection-state";
import "./inspection.css";

export interface PreviewInspectionProps {
  state: ConnectionState;
  dispatch: Dispatch<ConnectionAction>;
  theme: UiTheme;
  onThemeChange: (theme: UiTheme) => void;
  onClose: () => void;
}

export function PreviewInspection({
  state,
  dispatch,
  theme,
  onThemeChange,
  onClose,
}: PreviewInspectionProps) {
  const staleResult = state.staleResults[0];
  return (
    <aside className="ui-inspection-panel" aria-label="验收工具">
      <header className="ui-inspection-header">
        <h2>验收工具</h2>
        <Button onClick={onClose} aria-label="关闭验收工具">
          关闭
        </Button>
      </header>
      <label className="ui-inspection-theme">
        <span>主题</span>
        <Select
          aria-label="预览主题"
          value={theme}
          options={[
            { value: "light", label: "浅色" },
            { value: "dark", label: "深色" },
          ]}
          onValueChange={(value) => onThemeChange(value === "dark" ? "dark" : "light")}
        />
      </label>
      <div className="ui-inspection-actions">
        <Button
          onClick={() => dispatch({ type: "leave", intent: { kind: "page", page: "foundations" } })}
        >
          组件与样式
        </Button>
        <Button onClick={() => dispatch({ type: "reset" })}>重置示例</Button>
        <Button
          disabled={!staleResult}
          onClick={() => {
            if (staleResult) dispatch({ type: "complete", result: staleResult });
          }}
        >
          释放旧结果
        </Button>
      </div>
      <dl className="ui-inspection-counters" aria-live="polite">
        <div>
          <dt>已失效结果</dt>
          <dd>{state.staleResults.length}</dd>
        </div>
        <div>
          <dt>已忽略</dt>
          <dd>{state.ignoredResults}</dd>
        </div>
        <div>
          <dt>世代</dt>
          <dd>{state.generation}</dd>
        </div>
      </dl>
      <p className="ui-inspection-hint">编辑连接以检查失败与等待</p>
    </aside>
  );
}
