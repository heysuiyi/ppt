import type { ComponentPropsWithRef } from "react";

export type ButtonTone = "primary" | "neutral" | "danger";

/** 保留原生 button 与 ref；busy 只阻止操作并公开状态，不猜测或改写动作文字。 */
export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  tone?: ButtonTone;
  busy?: boolean;
}

export function Button({
  tone = "neutral",
  busy = false,
  type = "button",
  disabled,
  className,
  "aria-busy": ariaBusy,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={className ? `ui-button ${className}` : "ui-button"}
      data-ui-tone={tone}
      disabled={disabled || busy}
      aria-busy={busy ? true : ariaBusy}
    />
  );
}
