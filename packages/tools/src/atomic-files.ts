import {
  readJsonFile as readJsonFileInternal,
  writeJsonFileAtomic as writeJsonFileAtomicInternal,
  writeTextFileAtomic as writeTextFileAtomicInternal,
} from "./internal/files/atomic.js";

export { AtomicWriteConflictError } from "./internal/files/atomic-errors.js";

export interface AtomicFileWriteOptions {
  mode?: number;
}

export const readJsonFile: <T>(filePath: string) => Promise<T | undefined> = readJsonFileInternal;

export const writeJsonFileAtomic: (filePath: string, value: unknown) => Promise<void> =
  writeJsonFileAtomicInternal;

export const writeTextFileAtomic: (
  filePath: string,
  payload: string,
  options?: AtomicFileWriteOptions,
) => Promise<void> = writeTextFileAtomicInternal;
