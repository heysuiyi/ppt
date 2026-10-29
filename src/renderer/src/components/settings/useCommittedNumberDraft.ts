import { useEffect, useState } from "react";

export function useCommittedNumberDraft(
  value: number,
  onCommit: (value: number) => void,
  normalize: (draft: string, current: number) => number,
) {
  const [draft, setDraft] = useState(() => String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = normalize(draft, value);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return { draft, setDraft, commit };
}
