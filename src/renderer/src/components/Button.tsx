import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cx } from "../lib/cx";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "quiet" | "danger";
  size?: "sm" | "md";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", type = "button", className, ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={cx("ui-button", `ui-button--${variant}`, className)}
      data-ui-button=""
      data-variant={variant}
      data-size={size}
    />
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonProps>(function IconButton(
  { variant = "quiet", size = "sm", className, ...props },
  ref,
) {
  return (
    <Button
      {...props}
      ref={ref}
      variant={variant}
      size={size}
      className={cx("ui-icon-button", className)}
    />
  );
});
