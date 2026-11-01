import type { ReactNode } from "react";

export type AlertTone = "info" | "success" | "error";
export type AlertAnnouncement = "off" | "polite" | "assertive";

/** 持续区域信息不抢焦点、不计时消失；页面显式选择公告强度。 */
export interface AlertProps {
  title: string;
  children?: ReactNode;
  tone?: AlertTone;
  announce?: AlertAnnouncement;
}

export function Alert({ title, children, tone = "info", announce = "off" }: AlertProps) {
  return (
    <div
      className="ui-alert"
      data-ui-tone={tone}
      role={announce === "assertive" ? "alert" : announce === "polite" ? "status" : undefined}
      aria-live={announce}
      aria-atomic={announce === "off" ? undefined : true}
    >
      <p className="ui-alert__title">{title}</p>
      {children != null && <div className="ui-alert__content">{children}</div>}
    </div>
  );
}
