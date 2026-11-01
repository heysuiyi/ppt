import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
export type LockRelease = () => Promise<void>;
type ProperLockfile = {
  lock(
    file: string,
    options?: {
      realpath?: boolean;
      stale?: number;
      retries?:
        | number
        | {
            retries?: number;
            factor?: number;
            minTimeout?: number;
            maxTimeout?: number;
          };
    },
  ): Promise<LockRelease>;
};
const lockfile = createRequire(import.meta.url)("proper-lockfile") as ProperLockfile;
const STORE_LOCK_OPTIONS = {
  realpath: false,
  stale: 30_000,
  retries: {
    retries: 600,
    factor: 1,
    minTimeout: 10,
    maxTimeout: 100,
  },
} as const;

export async function acquireTransactionLock(filePath: string): Promise<LockRelease> {
  await mkdir(dirname(filePath), { recursive: true });
  return lockfile.lock(filePath, STORE_LOCK_OPTIONS);
}
