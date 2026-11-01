import type { ComponentPropsWithRef } from "react";

/** 输入与校验状态由表单持有；保留原生 ref、required、readOnly 和 disabled 语义。 */
export type InputProps = ComponentPropsWithRef<"input">;

export function Input({ type = "text", className, ...props }: InputProps) {
  return (
    <input {...props} type={type} className={className ? `ui-input ${className}` : "ui-input"} />
  );
}
