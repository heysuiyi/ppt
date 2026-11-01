import { forwardRef, type InputHTMLAttributes } from "react";
import { cx } from "../lib/cx";

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { label, className, ...props },
  ref,
) {
  return (
    <label className={cx("toggle-switch", className)} data-ui-switch="">
      <input {...props} ref={ref} type="checkbox" aria-label={props["aria-label"] ?? label} />
      <span className="toggle-slider" aria-hidden="true" />
    </label>
  );
});
