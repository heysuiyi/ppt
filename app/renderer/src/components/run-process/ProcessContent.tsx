import { ProcessRow } from "./ProcessRow";
import type { ProcessRowModel } from "./process-model";

export interface ProcessContentProps {
  rows: ProcessRowModel[];
  expandedDetails: Readonly<Record<string, boolean>>;
  onToggleDetail: (id: string) => void;
}

export function ProcessContent({ rows, expandedDetails, onToggleDetail }: ProcessContentProps) {
  return (
    <div className="run-process-content">
      {rows.map((row) => (
        <div key={row.id} data-run-block-id={row.id} data-run-block-kind={row.kind}>
          <ProcessRow
            row={row}
            expanded={expandedDetails[row.id] === true}
            onToggleDetail={onToggleDetail}
          />
        </div>
      ))}
    </div>
  );
}
