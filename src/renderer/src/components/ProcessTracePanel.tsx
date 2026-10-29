import type { AgentActivityItem } from "@shared/agent-activity";
import { summarizeProcessTrace } from "@shared/agent-activity";
import { buildProcessTraceRows } from "@shared/process-trace-rows";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "./Icons";
import { ProcessTraceItem } from "./ProcessTraceItem";
import { useChatFold } from "./useChatFold";

type UserPinned = "open" | "closed";

interface ProcessTracePanelProps {
  items: AgentActivityItem[];
  /** Batch still has running work or is the live trailing process. */
  live?: boolean;
  /** When true and not user-pinned, force collapsed (Cursor: tools done + text follows). */
  shouldAutoCollapse?: boolean;
  startedAt?: number;
  /** Persisted wall duration for historical / remounted completed panels. */
  durationMs?: number;
  /** When true, pin open (e.g. team detail). Disables auto open/close. */
  defaultOpen?: boolean;
  defaultExpandRows?: boolean;
}

function resolveAutoOpen(input: { live: boolean; shouldAutoCollapse: boolean }): boolean {
  if (input.shouldAutoCollapse) return false;
  return input.live;
}

function secondsFromDurationMs(durationMs: number): number {
  return Math.max(1, Math.round(durationMs / 1_000));
}

export const ProcessTracePanel: React.FC<ProcessTracePanelProps> = ({
  items,
  live = false,
  shouldAutoCollapse = false,
  startedAt,
  durationMs,
  defaultOpen = false,
  defaultExpandRows = false,
}) => {
  const { anchorRef: headerRef, transactFold } = useChatFold<HTMLButtonElement>();
  const [userPinned, setUserPinned] = useState<UserPinned | null>(defaultOpen ? "open" : null);
  const [open, setOpen] = useState(() => {
    if (defaultOpen) return true;
    return resolveAutoOpen({ live, shouldAutoCollapse });
  });
  const [elapsedSeconds, setElapsedSeconds] = useState(() =>
    !live && durationMs !== undefined ? secondsFromDurationMs(durationMs) : 0,
  );
  const startedAtRef = useRef<number | null>(live ? (startedAt ?? Date.now()) : null);
  const openRef = useRef(open);
  openRef.current = open;
  const userPinnedRef = useRef(userPinned);
  userPinnedRef.current = userPinned;

  const setOpenWithScroll = (nextOpen: boolean) => {
    if (openRef.current === nextOpen) return;
    transactFold(() => setOpen(nextOpen));
  };
  const setOpenWithScrollRef = useRef(setOpenWithScroll);
  setOpenWithScrollRef.current = setOpenWithScroll;

  useEffect(() => {
    if (!live) {
      if (durationMs !== undefined) {
        setElapsedSeconds(secondsFromDurationMs(durationMs));
        return;
      }
      if (startedAtRef.current !== null) {
        setElapsedSeconds(Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1_000)));
      }
      return;
    }

    if (startedAt !== undefined) {
      startedAtRef.current = startedAt;
    } else if (startedAtRef.current === null) {
      startedAtRef.current = Date.now();
    }
    const updateElapsed = () => {
      if (startedAtRef.current === null) return;
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1_000)));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [live, startedAt, durationMs]);

  useEffect(() => {
    if (live && startedAt !== undefined) {
      startedAtRef.current = startedAt;
    } else if (live && startedAtRef.current === null) {
      startedAtRef.current = Date.now();
    }

    if (userPinnedRef.current !== null) return;
    setOpenWithScrollRef.current(resolveAutoOpen({ live, shouldAutoCollapse }));
  }, [live, shouldAutoCollapse, startedAt]);

  const rows = useMemo(() => buildProcessTraceRows(items, live), [items, live]);

  if (rows.length === 0 && !live) return null;

  const processSummary = summarizeProcessTrace(items, { live });
  const completedMeta = !live && elapsedSeconds > 0 ? `已工作 ${elapsedSeconds} 秒` : null;
  const titleAttribute = completedMeta ? `${completedMeta} · ${processSummary}` : processSummary;

  const handleHeaderClick = () => {
    const nextOpen = !open;
    setUserPinned(nextOpen ? "open" : "closed");
    setOpenWithScroll(nextOpen);
  };

  return (
    <div className={`process-trace-panel${live ? " process-trace-panel--active" : ""}`}>
      <button
        ref={headerRef}
        type="button"
        className="process-trace-panel-header"
        onClick={handleHeaderClick}
        aria-expanded={open}
        aria-label={open ? "收起执行过程" : "展开执行过程"}
        title={titleAttribute}
      >
        <span className="process-trace-panel-header-left">
          {completedMeta ? (
            <>
              <span className="process-trace-panel-meta">{completedMeta}</span>
              <span className="process-trace-panel-separator" aria-hidden="true">
                ·
              </span>
              <span className="process-trace-panel-summary">{processSummary}</span>
            </>
          ) : (
            <span className="process-trace-panel-label">{processSummary}</span>
          )}
          {live && elapsedSeconds > 0 && (
            <span className="process-trace-panel-elapsed">{elapsedSeconds} 秒</span>
          )}
          <span className="process-trace-panel-caret" aria-hidden="true">
            {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          </span>
        </span>
      </button>
      {open && (
        <div className="process-trace-panel-body">
          {rows.map((row) => (
            <div
              key={row.id}
              className="agent-run-block agent-run-block--activity"
              data-run-block-id={row.id}
              data-run-block-kind={row.kind}
            >
              <ProcessTraceItem
                row={row}
                defaultExpanded={
                  defaultExpandRows ||
                  Boolean(row.streaming) ||
                  Boolean(row.active && row.kind !== "thought")
                }
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
