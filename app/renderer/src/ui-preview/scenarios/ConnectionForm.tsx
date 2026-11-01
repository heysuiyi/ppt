import { type Dispatch, type RefObject, useId, useLayoutEffect, useRef, useState } from "react";
import { Alert } from "../../ui/components/alert/Alert";
import { Button } from "../../ui/components/button/Button";
import { Dialog } from "../../ui/components/dialog/Dialog";
import { Field } from "../../ui/components/field/Field";
import { Input } from "../../ui/components/input/Input";
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
}

export function ConnectionForm({ state, dispatch, fallbackFocusRef }: ConnectionFormProps) {
  const editor = state.editor!;
  const prefix = useId();
  const formId = `${prefix}-form`;
  const nameRef = useRef<HTMLInputElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const firstErrorPending = useRef(false);
  const [outcome, setOutcome] = useState<LocalOutcome>("success");
  const [deferred, setDeferred] = useState(true);
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
      title="编辑本地示例连接"
      description="仅验证 UI 交互。不会连接模型、保存凭据或访问文件。"
      initialFocusRef={nameRef}
      fallbackFocusRef={fallbackFocusRef}
      onRequestClose={() => dispatch({ type: "leave", intent: { kind: "close" } })}
      footer={
        <>
          <Button onClick={() => dispatch({ type: "leave", intent: { kind: "close" } })}>
            取消编辑
          </Button>
          <Button type="submit" form={formId} tone="primary" busy={pending}>
            {pending ? "等待本地结果…" : "模拟提交"}
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
        <Field
          id={`${prefix}-name`}
          label="显示名称"
          error={editor.errors.name}
          required
          hint="仅更新本页内存中的示例名称。"
        >
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
        <Field
          id={`${prefix}-address`}
          label="示例连接地址"
          error={editor.errors.address}
          required
          hint="仅本地检查 http / https 地址格式，不发送请求。"
        >
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
          hint="仅粘贴 demo-key 或点击填入；其他输入立即拒绝，不保存、不回显。不要输入真实 Key。"
        >
          {(props) => (
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
          )}
        </Field>
        <div>
          <Button disabled={pending} onClick={() => dispatch(demoKeyChange("demo-key"))}>
            填入演示值 demo-key
          </Button>
        </div>
        {editor.failure && (
          <Alert title="本地模拟失败，输入已保留" tone="error" announce="assertive">
            这是显式选择的失败场景，不是网络错误。修正内容或选择本地成功后重试。
          </Alert>
        )}
        {pending && (
          <Alert title="本地等待中" announce="polite">
            可释放当前结果，或取消本地等待。取消后旧结果不能更新本次编辑。
          </Alert>
        )}
        <details className="ui-preview-controls" open>
          <summary>场景控制 · 仅本地</summary>
          <div className="ui-preview-controls-body">
            <label>
              完成结果{" "}
              <select
                aria-label="本地完成结果"
                value={outcome}
                disabled={pending}
                onChange={(event) => setOutcome(event.target.value as LocalOutcome)}
              >
                <option value="success">本地成功</option>
                <option value="failure">本地失败</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={deferred}
                disabled={pending}
                onChange={(event) => setDeferred(event.target.checked)}
              />
              暂缓完成，手动释放结果
            </label>
            <div className="ui-preview-actions">
              <Button
                disabled={!editor.operation}
                onClick={() => {
                  if (editor.operation) dispatch({ type: "complete", result: editor.operation });
                }}
              >
                释放当前结果
              </Button>
              <Button
                disabled={!state.staleResults.length}
                onClick={() => dispatch({ type: "complete", result: state.staleResults[0] })}
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
                离开到视觉基础
              </Button>
              <Button onClick={() => dispatch({ type: "reset" })}>重置本地场景</Button>
            </div>
          </div>
        </details>
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
