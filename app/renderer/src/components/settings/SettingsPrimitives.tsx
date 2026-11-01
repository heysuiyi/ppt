import {
  Children,
  cloneElement,
  type InputHTMLAttributes,
  isValidElement,
  type ReactNode,
  useId,
} from "react";
import { cx } from "../../lib/cx";
import { Button } from "../Button";
import { Input, Textarea } from "../Field";
import { Select } from "../Select";
import { Switch } from "../Switch";

export function SettingsRow({
  label,
  muted = false,
  children,
  hint,
}: {
  label: string;
  muted?: boolean;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const labelId = useId();
  const controlId = useId();
  const onlyChild = Children.count(children) === 1 ? Children.toArray(children)[0] : null;
  const field =
    isValidElement<{ id?: string; "aria-labelledby"?: string }>(onlyChild) &&
    (onlyChild.type === Input ||
      onlyChild.type === Textarea ||
      onlyChild.type === RangeField ||
      onlyChild.type === Switch ||
      onlyChild.type === Select ||
      (typeof onlyChild.type === "string" &&
        ["input", "textarea", "select", "button"].includes(onlyChild.type)))
      ? onlyChild
      : null;
  const fieldId = field?.props.id ?? controlId;
  const control = field
    ? cloneElement(field, {
        id: fieldId,
        "aria-labelledby": field.props["aria-labelledby"] ?? labelId,
      })
    : children;
  const labelContent = (
    <>
      {label}
      {hint ? <span className="settings-hint">{hint}</span> : null}
    </>
  );
  return (
    <div className={cx("settings-row", muted && "is-muted")}>
      {field ? (
        <label id={labelId} htmlFor={fieldId} className="settings-row-label">
          {labelContent}
        </label>
      ) : (
        <div id={labelId} className="settings-row-label">
          {labelContent}
        </div>
      )}
      <div
        className="settings-row-control"
        role={field ? undefined : "group"}
        aria-labelledby={field ? undefined : labelId}
      >
        {control}
      </div>
    </div>
  );
}

export function SettingsSection({
  title,
  hint,
  children,
  className,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("settings-section", className)}>
      <div className="settings-section-title">
        <h3>{title}</h3>
        {hint ? <span className="settings-hint">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function SettingsPanel({ children }: { children: ReactNode }) {
  return <div className="settings-panel">{children}</div>;
}

export function SettingsChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="settings-choice-group" role="group" aria-label={label}>
      {options.map((option) => (
        <Button
          key={option.value}
          size="sm"
          disabled={disabled}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          <span>{option.label}</span>
        </Button>
      ))}
    </div>
  );
}

export function RangeField({
  className,
  valueLabel,
  id,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { valueLabel: ReactNode }) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <div className="settings-range-field">
      <output className="settings-field-value" htmlFor={inputId}>
        {valueLabel}
      </output>
      <input {...props} id={inputId} className={cx("settings-range", className)} type="range" />
    </div>
  );
}
