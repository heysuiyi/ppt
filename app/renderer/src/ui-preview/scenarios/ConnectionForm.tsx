import { type Dispatch, type RefObject, useId, useLayoutEffect, useRef, useState } from "react";
import { Alert } from "../../ui/components/alert/Alert";
import { Button } from "../../ui/components/button/Button";
import { Dialog } from "../../ui/components/dialog/Dialog";
import { Field } from "../../ui/components/field/Field";
import { Input } from "../../ui/components/input/Input";
import { Select } from "../../ui/components/select/Select";
import { UnsavedChangesDialog } from "../../ui/patterns/UnsavedChangesDialog";
import {
  type ConnectionAction,
  type ConnectionState,
  demoKeyChange,
  type FieldName,
  type LocalOutcome,
} from "../state/connection-state";

interface ConnectionFormProps {
  state: ConnectionState;
  dispatch: Dispatch<ConnectionAction>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  inspection: boolean;
  onInspectionChange: (open: boolean) => void;
}

export function ConnectionForm({
  state,
  dispatch,
  fallbackFocusRef,
  inspection,
  onInspectionChange,
}: ConnectionFormProps) {
  const editor = state.editor!;
  const prefix = useId();
  const formId = `${prefix}-form`;
  const nameRef = useRef<HTMLInputElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const firstErrorPending = useRef(false);
  const [outcome, setOutcome] = useState<LocalOutcome>("success");
  const [deferred, setDeferred] = useState(inspection);
  // 只对显式从验收入口进入的场景提供工具；隐藏工具不重建编辑或改派发结果。
  const inspectionAvailable = useRef(inspection);
  const pending = editor.phase === "pending";
  const other = state.connections.find((item) => item.id !== editor.targetId)!;
  useLayoutEffect(() => {
    if (!firstErrorPending.current) return;
    firstErrorPending.current = false;
    const first = editor.errors.name
      ? nameRef
      : editor.errors.address
        ? addressRef
        : editor.errors.demoKey
          ? keyRef
          : null;
    first?.current?.focus();
  }, [editor.errors]);
  const change = (field: Exclude<FieldName, "demoKey">, value: string) =>
    dispatch({ type: "change", field, value });

  return (
    <Dialog
      open
      purpose="form"
      title="编辑连接"
      initialFocusRef={nameRef}
      fallbackFocusRef={fallbackFocusRef}
      onRequestClose={() => dispatch({ type: "leave", intent: { kind: "close" } })}
      footer={
        <>
          <Button onClick={() => dispatch({ type: "leave", intent: { kind: "close" } })}>
            取消
          </Button>
          <Button type="submit" form={formId} tone="primary" busy={pending}>
            {pending ? "等待结果…" : "保存示例"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="ui-preview-form"
        noValidate
        aria-busy={pending}
        onSubmit={(event) => {
          event.preventDefault();
          firstErrorPending.current = true;
          dispatch({ type: "submit", outcome, deferred });
        }}
      >
        <Field id={`${prefix}-name`} label="名称" error={editor.errors.name} required>
          {(props) => (
            <Input
              {...props}
              ref={nameRef}
              value={editor.draft.name}
              readOnly={pending}
              onChange={(event) => change("name", event.target.value)}
            />
          )}
        </Field>
        <Field id={`${prefix}-address`} label="地址" error={editor.errors.address} required>
          {(props) => (
            <Input
              {...props}
              ref={addressRef}
              type="url"
              value={editor.draft.address}
              readOnly={pending}
              onChange={(event) => change("address", event.target.value)}
            />
          )}
        </Field>
        <Field
          id={`${prefix}-key`}
          label="演示 Key"
          error={editor.errors.demoKey}
          required
          hint="仅 demo-key，勿填真实凭据。"
        >
          {(props) => (
            <div className="ui-preview-key-row">
              <Input
                {...props}
                ref={keyRef}
                autoComplete="off"
                value={editor.draft.demoKey}
                readOnly={pending}
                spellCheck={false}
                onChange={(event) => {
                  const action = demoKeyChange(event.currentTarget.value);
                  if (action.rejected) event.currentTarget.value = "";
                  dispatch(action);
                }}
              />
              <Button
                disabled={pending}
                onClick={() => dispatch(demoKeyChange("demo-key"))}
                aria-label="填入 demo-key"
              >
                填入
              </Button>
            </div>
          )}
        </Field>
        {editor.failure && (
          <Alert title="示例更新失败" tone="error" announce="assertive">
            输入已保留，请重试。
          </Alert>
        )}
        {pending && (
          <p className="ui-preview-operation-status" role="status">
            等待示例结果，可取消。
          </p>
        )}
        {inspectionAvailable.current && (
          <div className="ui-preview-form-inspection">
            <button
              type="button"
              className="ui-preview-text-action"
              aria-expanded={inspection}
              onClick={() => onInspectionChange(!inspection)}
            >
              {inspection ? "收起验收工具" : "验收工具"}
            </button>
            {inspection && (
              <div className="ui-preview-controls">
                <label>
                  完成结果{" "}
                  <Select
                    aria-label="本地完成结果"
                    value={outcome}
                    disabled={pending}
                    options={[
                      { value: "success", label: "本地成功" },
                      { value: "failure", label: "本地失败" },
                    ]}
                    onValueChange={(value) => setOutcome(value as LocalOutcome)}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={deferred}
                    disabled={pending}
                    onChange={(event) => setDeferred(event.target.checked)}
                  />
                  暂缓完成
                </label>
                <div className="ui-preview-actions">
                  <Button
                    disabled={!editor.operation}
                    onClick={() => {
                      if (editor.operation)
                        dispatch({ type: "complete", result: editor.operation });
                    }}
                  >
                    释放当前结果
                  </Button>
                  <Button
                    disabled={!state.staleResults.length}
                    onClick={() => {
                      const result = state.staleResults[0];
                      if (result) dispatch({ type: "complete", result });
                    }}
                  >
                    释放旧结果
                  </Button>
                </div>
                <p className="ui-preview-meta" role="status">
                  已失效结果 {state.staleResults.length} · 已忽略 {state.ignoredResults} · 世代{" "}
                  {state.generation}
                </p>
                <div className="ui-preview-actions">
                  <Button
                    onClick={() =>
                      dispatch({ type: "leave", intent: { kind: "target", targetId: other.id } })
                    }
                  >
                    切换到 {other.name}
                  </Button>
                  <Button
                    onClick={() =>
                      dispatch({ type: "leave", intent: { kind: "page", page: "foundations" } })
                    }
                  >
                    组件与样式
                  </Button>
                  <Button onClick={() => dispatch({ type: "reset" })}>重置示例</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </form>
      <UnsavedChangesDialog
        open={Boolean(state.leave)}
        fallbackFocusRef={nameRef}
        onContinueEditing={() => dispatch({ type: "stay" })}
        onDiscard={() => dispatch({ type: "discard" })}
      />
    </Dialog>
  );
}
