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

/**
 * 文件权限由宿主执行管线决定，插件只持有只读端口，不知道根目录、凭据或 Agent 状态。
 * 外层闭包提供业务实现；setup 只声明能力，不执行读取，也不启动下一轮模型调用。
 */
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
        // 模型消费的是结果投影，不是文件服务对象；业务输出的存储结构可独立演进。
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
