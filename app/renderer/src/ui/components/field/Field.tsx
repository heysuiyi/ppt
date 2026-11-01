import type { ReactNode } from "react";

/** 字段只关联标签和就地说明；何时校验、提交后聚焦哪个错误由表单决定。 */
export interface FieldControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": boolean | undefined;
  required: boolean;
}

export interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: (props: FieldControlProps) => ReactNode;
}

export function Field({ id, label, hint, error, required = false, children }: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = hintId && errorId ? `${hintId} ${errorId}` : hintId || errorId;

  return (
    <div className="ui-field">
      <label className="ui-field__label" htmlFor={id}>
        {label}
        {required && (
          <span className="ui-field__required" aria-hidden="true">
            （必填）
          </span>
        )}
      </label>
      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
        required,
      })}
      {hint && (
        <p className="ui-field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="ui-field__error" id={errorId}>
          错误：{error}
        </p>
      )}
    </div>
  );
}
