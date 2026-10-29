import type { AgentActivityItem } from "@shared/agent-activity";
import { useCallback, useMemo, useState } from "react";
import { ProcessContent } from "./ProcessContent";
import { buildProcessView } from "./process-model";

export function ProcessRecord({ items, live }: { items: AgentActivityItem[]; live: boolean }) {
  const view = useMemo(() => buildProcessView(items, { live }), [items, live]);
  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({});
  const onToggleDetail = useCallback((id: string) => {
    setExpandedDetails((previous) => ({ ...previous, [id]: previous[id] !== true }));
  }, []);

  if (view.rows.length === 0) return null;

  return (
    <div className="run-process-record">
      <ProcessContent
        rows={view.rows}
        expandedDetails={expandedDetails}
        onToggleDetail={onToggleDetail}
      />
    </div>
  );
}
