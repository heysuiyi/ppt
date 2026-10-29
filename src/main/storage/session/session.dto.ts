import type { SessionSnapshot } from "@shared/session";

export interface StoredSession {
  id: string;
  ordinal: number;
  snapshotJson: string;
}

export interface SessionWrite {
  id: string;
  ordinal: number;
  snapshot: Omit<SessionSnapshot, "messages">;
}
