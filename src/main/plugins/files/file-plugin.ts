import { z } from "zod";
import type { AgentPlugin } from "../../../agent/extensions/plugin-contract";
import { FileReadError, type FileReadPort, MAX_FILE_READ_BYTES } from "./file-read-port";

const outputSchema = z
  .object({
    path: z.string().min(1),
    version: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    size: z.number().int().min(0).max(MAX_FILE_READ_BYTES),
    content: z.string(),
  })
  .strict()
  .refine((value) => Buffer.byteLength(value.content, "utf8") <= MAX_FILE_READ_BYTES);

/** 文件权限由宿主执行管线决定，插件只持有只读能力。 */
export function createFilePlugin(reader: FileReadPort): AgentPlugin {
  return {
    id: "files",
    version: "1",
    setup(context) {
      context.tools.register({
        name: "ReadFile",
        owner: "files",
        version: "1",
        description:
          "Read a complete UTF-8 text file of at most 65536 bytes using a workspace-relative path.",
        inputSchema: z.object({ path: z.string().min(1) }).strict(),
        outputSchema,
        mode: "immediate",
        async execute(input, execution) {
          try {
            const output = await reader.read(input.path, execution.signal);
            return { status: "succeeded", output, effects: "none" };
          } catch (error) {
            const safe =
              error instanceof FileReadError ? error : new FileReadError("FILE_READ_FAILED");
            return {
              status: "failed",
              error: { code: safe.code, message: safe.message },
              effects: "none",
            };
          }
        },
        toModelContent(result) {
          return [
            {
              type: "text",
              text:
                result.status === "succeeded"
                  ? JSON.stringify(result.output)
                  : `${result.error.code}: ${result.error.message}`,
            },
          ];
        },
      });
    },
  };
}
