import { useCallback, useId, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "../Icons";
import { ProcessContent } from "./ProcessContent";
import type { ProcessView } from "./process-model";
import { ProcessFoldBoundary, useProcessDisclosure } from "./useProcessDisclosure";

export function ProcessSection({ view }: { view: ProcessView }) {
  const bodyId = useId();
  const hasRows = view.rows.length > 0;
  const { open, anchorRef, toggle, foldBoundaryProps } = useProcessDisclosure(
    view.active && hasRows,
  );
  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({});
  const onToggleDetail = useCallback((id: string) => {
    setExpandedDetails((previous) => ({ ...previous, [id]: previous[id] !== true }));
  }, []);

  const header = (
    <>
      <span className="run-process-section-label">{view.title}</span>
      {view.attention && <span className="run-process-attention">需关注</span>}
      {hasRows && (
        <span className="run-process-caret" aria-hidden="true">
          {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </span>
      )}
    </>
  );

  return (
    <ProcessFoldBoundary
      {...foldBoundaryProps}
      open={hasRows && open}
      automatic={!hasRows || foldBoundaryProps.automatic}
    >
      {(view.active || hasRows) && (
        <div
          className={`run-process-section${view.active ? " run-process-section--active" : ""}${view.attention ? " run-process-section--attention" : ""}`}
        >
          {hasRows ? (
            <button
              ref={anchorRef}
              type="button"
              className="run-process-section-header"
              onClick={toggle}
              aria-expanded={open}
              aria-label={open ? "收起执行过程" : "展开执行过程"}
              title={view.title}
              aria-controls={bodyId}
            >
              {header}
            </button>
          ) : (
            <div className="run-process-section-header run-process-section-header--static">
              {header}
            </div>
          )}
          {hasRows && open && (
            <div id={bodyId} className="run-process-section-body">
              <ProcessContent
                rows={view.rows}
                expandedDetails={expandedDetails}
                onToggleDetail={onToggleDetail}
              />
            </div>
          )}
        </div>
      )}
    </ProcessFoldBoundary>
  );
}
