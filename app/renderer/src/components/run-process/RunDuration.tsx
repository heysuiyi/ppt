import { useEffect, useState } from "react";

interface RunDurationProps {
  live: boolean;
  startedAt?: number;
  durationMs?: number;
}

export function RunDuration({ live, startedAt, durationMs }: RunDurationProps) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!live || startedAt === undefined) return;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [live, startedAt]);

  // The clock only invalidates render; elapsed time always uses current authoritative props.
  const milliseconds = live
    ? startedAt === undefined
      ? undefined
      : Date.now() - startedAt
    : durationMs;
  if (milliseconds === undefined) return null;
  const seconds = Math.max(
    0,
    live ? Math.floor(milliseconds / 1_000) : Math.round(milliseconds / 1_000),
  );

  return (
    <span className="run-process-duration" aria-label={`运行时长 ${seconds} 秒`}>
      {live ? "已运行" : "总耗时"} {seconds} 秒
    </span>
  );
}
