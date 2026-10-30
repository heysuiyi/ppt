import { relative, win32 } from "node:path";
import {
  canonicalizeWorkspaceRoot,
  WorkspaceFileError,
} from "../agent/tools/files/workspace-file-service";
import { readStableSnapshot } from "../agent/tools/files/workspace-file-snapshot";
import {
  captureWorkspacePathGuard,
  resolveContainedWorkspacePath,
} from "../agent/tools/files/workspace-path-guard";
import {
  FileReadError,
  type FileReadPort,
  MAX_FILE_READ_BYTES,
} from "../plugins/files/file-read-port";

export interface WorkspaceReader extends FileReadPort {
  readonly workspaceRoot: string;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new FileReadError("FILE_READ_CANCELLED");
}

function safeReadError(error: unknown): FileReadError {
  if (error instanceof FileReadError) return error;
  if (error instanceof WorkspaceFileError) {
    switch (error.code) {
      case "OUTSIDE_WORKSPACE":
      case "UNSAFE_FILE_TYPE":
      case "INVALID_UTF8":
      case "FILE_TOO_LARGE":
      case "STALE_FILE":
        return new FileReadError(error.code);
    }
  }
  if (error && typeof error === "object" && "code" in error) {
    switch (error.code) {
      case "ENOENT":
        return new FileReadError("FILE_NOT_FOUND");
      case "EACCES":
      case "EPERM":
        return new FileReadError("FILE_ACCESS_DENIED");
      case "EISDIR":
      case "ENOTDIR":
      case "ELOOP":
        return new FileReadError("UNSAFE_FILE_TYPE");
    }
  }
  return new FileReadError("FILE_READ_FAILED");
}

export async function createWorkspaceReader(workspaceRoot: string): Promise<WorkspaceReader> {
  let canonicalRoot: string;
  try {
    if (!workspaceRoot.trim()) throw new FileReadError("INVALID_WORKSPACE");
    canonicalRoot = canonicalizeWorkspaceRoot(workspaceRoot);
    await resolveContainedWorkspacePath(canonicalRoot, ".");
  } catch {
    throw new FileReadError("INVALID_WORKSPACE");
  }
  return {
    workspaceRoot: canonicalRoot,
    async read(path, signal) {
      try {
        assertNotAborted(signal);
        // Windows 路径在非 Windows 宿主上也不能被当作相对文件名。
        if (!path.trim() || path.includes("\0") || win32.isAbsolute(path) || path.includes(":")) {
          throw new FileReadError("INVALID_PATH");
        }
        const relativePath = path.replace(/\\/g, "/");
        // inspect 会恢复旧写入事务；这里只组合相同的只读安全原语。
        const absolutePath = await resolveContainedWorkspacePath(canonicalRoot, relativePath);
        assertNotAborted(signal);
        const guard = await captureWorkspacePathGuard(canonicalRoot, absolutePath, relativePath);
        assertNotAborted(signal);
        const result = await readStableSnapshot(absolutePath, MAX_FILE_READ_BYTES);
        assertNotAborted(signal);
        await guard.validate();
        assertNotAborted(signal);
        // 旧服务验证 UTF-8，但允许 NUL 等二进制控制字符；只读能力保守拒绝。
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result.content)) {
          throw new FileReadError("BINARY_FILE");
        }
        return {
          path: relative(canonicalRoot, result.absolutePath).replace(/\\/g, "/"),
          version: result.version,
          size: result.size,
          content: result.content,
        };
      } catch (error) {
        assertNotAborted(signal);
        throw safeReadError(error);
      }
    },
  };
}
