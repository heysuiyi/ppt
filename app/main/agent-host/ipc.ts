import type { AgentConfiguration } from "@agent-harness/configuration/configuration";
import { AgentError } from "@agent-harness/core/protocol-errors";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { z } from "zod";
import type { HarnessDesktopApi, HarnessReply } from "../../shared/harness-ipc";
import { DesktopHarnessHost, desktopError } from "./desktop-host";
import { createRecentWorkspaces } from "./workspaces";

export interface DesktopHarnessRegistration {
  documentCommitted(webContentsId: number): Promise<void>;
  invalidateDocument(webContentsId: number): Promise<void>;
  closeWindow(webContentsId: number): Promise<void>;
  close(): Promise<void>;
}

const idSchema = z.string().min(1);
const newSessionSchema = z
  .object({
    modelId: idSchema,
    toolsMode: z.enum(["none", "read-only", "read-write"]),
  })
  .strict();
const runSchema = z.object({ sessionId: idSchema, text: z.string() }).strict();
const resumeSchema = z
  .object({
    sessionId: idSchema,
    queryId: idSchema,
    interactionId: idSchema.optional(),
    choiceId: z.enum(["allow", "reject"]).optional(),
  })
  .strict();
const cancelSchema = z
  .object({
    sessionId: idSchema,
    queryId: idSchema,
    runId: idSchema.optional(),
  })
  .strict();

interface DesktopDocument {
  readonly generation: number;
  readonly ready: Promise<void>;
  readonly pending: Set<Promise<unknown>>;
  active: boolean;
  host?: DesktopHarnessHost;
  retirement?: Promise<void>;
}

interface DesktopWindow {
  generation: number;
  document?: DesktopDocument;
  drain: Promise<void>;
  closed: boolean;
  closing?: Promise<void>;
}

export function registerDesktopHarnessIpc(options: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly configuration: AgentConfiguration;
  readonly dataRoot: string;
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly chooseDirectory: (
    sender: WebContents,
    assertCurrentDocument: () => void,
  ) => Promise<string | undefined>;
}): DesktopHarnessRegistration {
  const workspaces = createRecentWorkspaces(options.dataRoot);
  const windows = new Map<number, DesktopWindow>();
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const windowFor = (webContentsId: number): DesktopWindow => {
    let window = windows.get(webContentsId);
    if (!window) {
      window = { generation: 0, drain: Promise.resolve(), closed: false };
      windows.set(webContentsId, window);
    }
    return window;
  };
  const assertCurrentDocument = (
    window: DesktopWindow,
    document: DesktopDocument,
    event: IpcMainInvokeEvent,
  ): void => {
    if (
      closing ||
      window.closed ||
      window.document !== document ||
      window.generation !== document.generation ||
      !document.active ||
      event.sender.isDestroyed()
    )
      throw new AgentError("HOST_CLOSED", "桌面文档已失效。");
    options.assertTrusted(event);
  };
  const retireDocument = (window: DesktopWindow): Promise<void> => {
    const document = window.document;
    if (!document) return window.drain;
    document.active = false;
    window.document = undefined;
    if (!document.retirement) {
      let hostClose: Promise<void>;
      try {
        hostClose = document.host?.close() ?? Promise.resolve();
      } catch {
        hostClose = Promise.reject(
          new AgentError("HOST_CLOSE_FAILED", "桌面宿主资源未能全部关闭。"),
        );
      }
      document.retirement = (async () => {
        // Admission is already closed: this set cannot acquire another old-document operation.
        const results = await Promise.allSettled([document.ready, hostClose, ...document.pending]);
        if (results.some((result) => result.status === "rejected"))
          throw new AgentError("HOST_CLOSE_FAILED", "桌面文档资源未能全部关闭。");
      })();
    }
    window.drain = document.retirement;
    return window.drain;
  };
  const closeWindow = (webContentsId: number): Promise<void> => {
    const window = windowFor(webContentsId);
    if (!window.closing) {
      window.closed = true;
      window.closing = retireDocument(window);
    }
    return window.closing;
  };
  const handlers: Record<
    Exclude<keyof HarnessDesktopApi, "subscribe">,
    (host: DesktopHarnessHost, argument: unknown) => Promise<unknown>
  > = {
    snapshot: (host) => host.snapshot(),
    models: (host) => host.models(),
    sessions: (host) => host.sessions(),
    chooseWorkspace: (host) => host.chooseWorkspace(),
    selectWorkspace: (host, id) => host.selectWorkspace(idSchema.parse(id)),
    setDefaultModel: (host, id) => host.setDefaultModel(idSchema.optional().parse(id)),
    newSession: (host, request) => host.newSession(newSessionSchema.parse(request)),
    selectSession: (host, id) => host.selectSession(idSchema.parse(id)),
    run: (host, request) => host.run(runSchema.parse(request)),
    resume: (host, request) => host.resume(resumeSchema.parse(request)),
    cancel: (host, request) => host.cancel(cancelSchema.parse(request)),
  };
  for (const [method, handler] of Object.entries(handlers)) {
    options.ipcMain.handle(`harness:${method}`, (event, argument: unknown) => {
      let document: DesktopDocument | undefined;
      const operation = (async (): Promise<HarnessReply<unknown>> => {
        try {
          options.assertTrusted(event);
          const window = windows.get(event.sender.id);
          document = window?.document;
          if (!window || !document)
            throw new AgentError("HOST_CLOSED", "桌面文档尚未就绪或已失效。");
          assertCurrentDocument(window, document, event);
          await document.ready;
          assertCurrentDocument(window, document, event);
          let host = document.host;
          if (!host) {
            const capturedDocument = document;
            const assertCurrent = () => assertCurrentDocument(window, capturedDocument, event);
            host = new DesktopHarnessHost({
              configuration: options.configuration,
              dataRoot: options.dataRoot,
              workspaces,
              chooseDirectory: async () => {
                assertCurrent();
                const selected = await options.chooseDirectory(event.sender, assertCurrent);
                assertCurrent();
                return selected;
              },
              emit: (value) => {
                assertCurrent();
                event.sender.send("harness:event", value);
              },
            });
            document.host = host;
          }
          const value = await handler(host, argument);
          assertCurrentDocument(window, document, event);
          return { ok: true, value };
        } catch (error) {
          return { ok: false, error: desktopError(error) };
        }
      })();
      pending.add(operation);
      document?.pending.add(operation);
      void operation.then(() => {
        pending.delete(operation);
        document?.pending.delete(operation);
      });
      return operation;
    });
  }
  return {
    documentCommitted(webContentsId) {
      const window = windowFor(webContentsId);
      if (closing || window.closed)
        return Promise.reject(new AgentError("HOST_CLOSED", "桌面窗口正在关闭。"));
      const ready = retireDocument(window);
      window.document = {
        generation: ++window.generation,
        ready,
        pending: new Set(),
        active: true,
      };
      return ready;
    },
    invalidateDocument(webContentsId) {
      return retireDocument(windowFor(webContentsId));
    },
    closeWindow,
    close() {
      if (!closing) {
        closing = (async () => {
          const results = await Promise.allSettled([...windows.keys()].map(closeWindow));
          await Promise.allSettled([...pending]);
          for (const method of Object.keys(handlers))
            options.ipcMain.removeHandler(`harness:${method}`);
          if (results.some((result) => result.status === "rejected"))
            throw new AgentError("HOST_CLOSE_FAILED", "桌面窗口资源未能全部关闭。");
        })();
      }
      return closing;
    },
  };
}
