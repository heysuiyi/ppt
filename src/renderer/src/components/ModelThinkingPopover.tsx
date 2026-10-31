import { getModelReasoningEfforts, getModelReasoningLabel } from "@shared/model-reasoning";
import { type CSSProperties, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ManagedModel } from "../modelCatalog";
import { CheckIcon, ChevronDownIcon } from "./Icons";
import { useOverlayLayer, useOverlayOwner } from "./overlay-lifecycle";
import { usePopoverPosition } from "./popover-position";

interface ModelThinkingPopoverProps {
  models: ManagedModel[];
  value: string;
  onChange: (id: string) => void;
  reasoningEffort?: string;
  onReasoningEffortChange: (effort: string | undefined) => void;
  disabled: boolean;
  placement: "above" | "below";
}

/** 两页共用浮层与锚点；选模型仅返回思考页，不结束本次设置。 */
export function ModelThinkingPopover({
  models,
  value,
  onChange,
  reasoningEffort,
  onReasoningEffortChange,
  disabled,
  placement,
}: ModelThinkingPopoverProps) {
  const [page, setPage] = useState<"thinking" | "models" | null>(null);
  const owner = useOverlayOwner();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const modelLink = useRef<HTMLButtonElement>(null);
  const selected = models.find((model) => model.id === value);
  const efforts = selected ? getModelReasoningEfforts(selected) : [];
  const levels = ["", ...efforts];
  const level = Math.max(0, levels.indexOf(reasoningEffort ?? ""));
  const open = page !== null && !disabled && models.length > 0;
  const position = usePopoverPosition(
    open,
    root,
    () => trigger.current?.getBoundingClientRect() ?? null,
    placement,
    300,
  );
  const close = useCallback(() => setPage(null), []);
  const back = useCallback(() => setPage("thinking"), []);
  useOverlayLayer(open, {
    depth: owner.depth + 1,
    root: () => root.current,
    trigger: () => trigger.current,
    outside: true,
    dismiss: close,
    escape: page === "models" ? back : close,
  });
  useEffect(() => {
    if (disabled || models.length === 0) close();
  }, [disabled, models.length, close]);
  useEffect(() => {
    if (!open) return;
    if (page === "thinking") modelLink.current?.focus();
    else
      root.current
        ?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')
        ?.focus();
  }, [open, page]);
  const choose = (id: string) => {
    onChange(id);
    back();
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="model-thinking-trigger"
        aria-label="选择智能体模型"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled || models.length === 0}
        onClick={() => setPage(open ? null : "thinking")}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setPage("thinking");
          }
        }}
      >
        <span>{selected?.name ?? "选择模型"}</span>
        <ChevronDownIcon size={12} />
      </button>
      {open
        ? createPortal(
            <div
              ref={root}
              id={id}
              role="dialog"
              aria-label={page === "thinking" ? "模型与思考强度" : "选择模型"}
              className="model-thinking-popover"
              style={
                position
                  ? {
                      top: position.top,
                      left: position.left,
                      width: position.width,
                      maxHeight: position.maxHeight,
                    }
                  : { visibility: "hidden" }
              }
            >
              {page === "thinking" ? (
                <div className="model-thinking-card">
                  <strong className="model-thinking-intensity">
                    {efforts.length ? getModelReasoningLabel(levels[level] || undefined) : "默认"}
                  </strong>
                  <button
                    ref={modelLink}
                    type="button"
                    className="model-thinking-model"
                    onClick={() => setPage("models")}
                  >
                    <span>{selected?.name ?? "选择模型"}</span>
                    <span aria-hidden="true">›</span>
                  </button>
                  {efforts.length ? (
                    <>
                      <input
                        className="model-thinking-slider"
                        type="range"
                        aria-label="思考强度"
                        aria-valuetext={getModelReasoningLabel(levels[level] || undefined)}
                        min={0}
                        max={levels.length - 1}
                        step={1}
                        value={level}
                        style={
                          {
                            "--reasoning-progress": `${(level / (levels.length - 1)) * 100}%`,
                          } as CSSProperties
                        }
                        onChange={(event) =>
                          onReasoningEffortChange(levels[Number(event.target.value)] || undefined)
                        }
                      />
                      <div className="model-thinking-scale" aria-hidden="true">
                        <span>默认</span>
                        <span>{getModelReasoningLabel(efforts[efforts.length - 1])}</span>
                      </div>
                    </>
                  ) : (
                    <p className="model-thinking-unavailable">此模型暂不支持调节思考强度</p>
                  )}
                </div>
              ) : (
                <div className="model-thinking-picker">
                  <button type="button" className="model-thinking-back" onClick={back}>
                    ‹ 返回思考设置
                  </button>
                  <div
                    role="listbox"
                    aria-label="模型列表"
                    onKeyDown={(event) => {
                      const options = Array.from(
                        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'),
                      );
                      const index = options.indexOf(document.activeElement as HTMLButtonElement);
                      let next: number;
                      if (event.key === "ArrowDown") next = (index + 1) % options.length;
                      else if (event.key === "ArrowUp")
                        next = (index - 1 + options.length) % options.length;
                      else if (event.key === "Home") next = 0;
                      else if (event.key === "End") next = options.length - 1;
                      else return;
                      event.preventDefault();
                      options[next]?.focus();
                    }}
                  >
                    {models.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        role="option"
                        aria-selected={model.id === value}
                        tabIndex={model.id === value ? 0 : -1}
                        className="model-thinking-option"
                        onClick={() => choose(model.id)}
                      >
                        <span>
                          <span className="model-thinking-option-name">{model.name}</span>
                          <small>{model.vendorLabel}</small>
                        </span>
                        {model.id === value ? <CheckIcon size={14} /> : null}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>,
            owner.portalHost ?? document.body,
          )
        : null}
    </>
  );
}
