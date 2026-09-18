import type { DisplayEvent } from "@shared/card-display-protocol";
import {
  ingestDisplayEvent,
  setDisplayCardStatus,
  useEnvironmentCardManager,
} from "@shared/cards/display-card-managers";
import type React from "react";
import { useEffect, useMemo } from "react";
import { FolderIcon } from "../../components/Icons";

interface EnvironmentCardHostProps {
  ready: boolean;
  onPrepare?: () => void;
  disabled?: boolean;
}

type EnvironmentEvent = Extract<DisplayEvent, { kind: "environment.action-required" }>;

/** Frontend/system-owned environment guidance; never depends on an Agent tool call. */
export const EnvironmentCardHost: React.FC<EnvironmentCardHostProps> = ({
  ready,
  onPrepare,
  disabled,
}) => {
  const derivedEvent = useMemo<EnvironmentEvent>(
    () => ({
      protocolVersion: 1,
      eventId: "environment:workspace-optional",
      emittedAt: new Date().toISOString(),
      kind: "environment.action-required",
      category: "environment",
      source: { kind: "frontend", feature: "workspace-preflight" },
      scope: {},
      semantics: {
        blocking: false,
        requiresResponse: false,
        priority: "low",
      },
      payload: {
        code: "workspace-optional",
        title: "项目目录（可选）",
        message: "可直接发送，系统会自动创建托管沙箱；也可以先选择保存目录。",
        actionLabel: "选择项目目录",
      },
    }),
    [],
  );
  const card = useEnvironmentCardManager((state) => state.cards).find(
    (item) =>
      item.event.kind === "environment.action-required" &&
      item.event.payload.code === "workspace-optional" &&
      item.status === "active",
  );
  const event = card?.event.kind === "environment.action-required" ? card.event : undefined;

  useEffect(() => {
    if (ready) {
      if (event) setDisplayCardStatus(event.eventId, "resolved");
      return;
    }
    if (event) return;
    ingestDisplayEvent(derivedEvent);
  }, [derivedEvent, event, ready]);

  const visibleEvent = ready ? undefined : (event ?? derivedEvent);
  if (!visibleEvent) return null;
  return (
    <section className="sandbox-preflight-card" aria-labelledby="sandbox-preflight-title">
      <div className="sandbox-preflight-icon">
        <FolderIcon size={18} />
      </div>
      <div className="sandbox-preflight-copy">
        <strong id="sandbox-preflight-title">{visibleEvent.payload.title}</strong>
        <span>{visibleEvent.payload.message}</span>
      </div>
      <button
        type="button"
        className="sandbox-preflight-btn"
        onClick={onPrepare}
        disabled={disabled}
      >
        {visibleEvent.payload.actionLabel ?? "继续"}
      </button>
    </section>
  );
};
