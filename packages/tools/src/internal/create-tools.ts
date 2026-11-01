import type { Logger } from "@agent-harness/logs/log-contract";
import { z } from "zod";
import type { ToolsOptions, ToolsPlugin } from "../tools-contract.js";
import { ToolsError } from "../tools-errors.js";
import { createEdit } from "./definitions/edit.js";
import { createGlob } from "./definitions/glob.js";
import { createGrep } from "./definitions/grep.js";
import { createRead } from "./definitions/read.js";
import { createWrite } from "./definitions/write.js";
import { withToolLogging } from "./tool-logging.js";
import { Workspace } from "./workspace.js";
import { prepareWorkspaceRoot } from "./workspace-root.js";

const DEFAULT_MAX_FILE_BYTES = 65536;
const DEFAULT_MAX_SCAN_ENTRIES = 10000;
const DEFAULT_MAX_SEARCH_BYTES = 8 * 1024 * 1024;

const optionsSchema = z
  .object({
    workspaceRoot: z.string().min(1).max(4096),
    mode: z.enum(["read-only", "read-write"]).default("read-only"),
    maxFileBytes: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024)
      .default(DEFAULT_MAX_FILE_BYTES),
    maxScanEntries: z.number().int().min(1).max(100000).default(DEFAULT_MAX_SCAN_ENTRIES),
    maxSearchBytes: z
      .number()
      .int()
      .min(1)
      .max(128 * 1024 * 1024)
      .default(DEFAULT_MAX_SEARCH_BYTES),
  })
  .strict();

/** 工厂只校验工作区；Logger 由宿主借用，每次安装的读取记录仍独立。 */
export async function createTools(options: ToolsOptions, logger?: Logger): Promise<ToolsPlugin> {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) throw new ToolsError("INVALID_OPTIONS");
  const configuration = parsed.data;
  const workspaceRoot = await prepareWorkspaceRoot(configuration.workspaceRoot);
  const { mode } = configuration;
  const toolNames: readonly string[] = Object.freeze(
    mode === "read-write" ? ["read", "glob", "grep", "write", "edit"] : ["read", "glob", "grep"],
  );

  return {
    id: "tools",
    version: "1",
    workspaceRoot,
    mode,
    toolNames,
    setup(context) {
      const workspace = new Workspace({
        workspaceRoot,
        maxFileBytes: configuration.maxFileBytes,
        maxScanEntries: configuration.maxScanEntries,
        maxSearchBytes: configuration.maxSearchBytes,
      });
      context.scope.own({
        async dispose() {
          workspace.clear();
        },
      });
      context.tools.register(
        withToolLogging(
          createRead((input, execution) => workspace.read(input, execution.signal)),
          logger,
        ),
      );
      context.tools.register(
        withToolLogging(
          createGlob((input, execution) => workspace.glob(input, execution.signal)),
          logger,
        ),
      );
      context.tools.register(
        withToolLogging(
          createGrep((input, execution) => workspace.grep(input, execution.signal)),
          logger,
        ),
      );
      if (mode === "read-write") {
        context.tools.register(
          withToolLogging(
            createWrite((input, execution) => workspace.write(input, execution.signal)),
            logger,
          ),
        );
        context.tools.register(
          withToolLogging(
            createEdit((input, execution) => workspace.edit(input, execution.signal)),
            logger,
          ),
        );
      }
    },
  };
}
