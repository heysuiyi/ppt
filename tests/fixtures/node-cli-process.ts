import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { z } from "zod";

export interface CliProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export interface CliChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly finished: Promise<CliProcessResult>;
  waitFor(channel: "stdout" | "stderr", pattern: RegExp): Promise<RegExpMatchArray>;
}

export function cliChild(
  root: string,
  endpoint: string,
  args: readonly string[],
  mode = "run",
  requireReadApproval = false,
): CliChild {
  const child = spawn(
    process.execPath,
    [resolve("tests/fixtures/node-cli-entry.mjs"), mode, ...args],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 25000,
      env: {
        ...process.env,
        TERM: "dumb",
        CLI_TEST_DATA_DIR: join(root, "data"),
        CLI_TEST_WORKSPACE: join(root, "workspace"),
        CLI_TEST_HTTP_ENDPOINT: endpoint,
        CLI_TEST_REQUIRE_READ: requireReadApproval ? "1" : "0",
      },
    },
  );
  let stdout = "";
  let stderr = "";
  let ended = false;
  const waiting: Array<{
    channel: "stdout" | "stderr";
    pattern: RegExp;
    resolve: (match: RegExpMatchArray) => void;
    reject: (error: Error) => void;
  }> = [];
  const update = () => {
    for (const entry of [...waiting]) {
      const match = (entry.channel === "stdout" ? stdout : stderr).match(entry.pattern);
      if (match) {
        waiting.splice(waiting.indexOf(entry), 1);
        entry.resolve(match);
      } else if (ended) {
        waiting.splice(waiting.indexOf(entry), 1);
        entry.reject(new Error("CLI exited before expected terminal state"));
      }
    }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    update();
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    update();
  });
  const finished = once(child, "close").then(([code]) => {
    ended = true;
    update();
    return { code: code as number | null, stdout, stderr };
  });
  return {
    child,
    finished,
    waitFor(channel, pattern) {
      const pending = Promise.withResolvers<RegExpMatchArray>();
      waiting.push({ channel, pattern, resolve: pending.resolve, reject: pending.reject });
      update();
      return pending.promise;
    },
  };
}

export async function runCliChild(
  root: string,
  endpoint: string,
  args: readonly string[],
  input = "",
  mode = "run",
  requireReadApproval = false,
): Promise<CliProcessResult> {
  const launched = cliChild(root, endpoint, args, mode, requireReadApproval);
  launched.child.stdin.end(input);
  return launched.finished;
}

export function jsonlRecords(result: CliProcessResult): Array<Record<string, unknown>> {
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
}

const querySchema = z.object({
  type: z.literal("query.result"),
  identity: z.object({
    agentId: z.string(),
    threadId: z.string(),
    queryId: z.string(),
    runId: z.string(),
  }),
  status: z.enum(["completed", "waiting", "cancelled", "interrupted", "failed"]),
  interaction: z.object({ interactionId: z.string() }).optional(),
});
export function queryRecord(result: CliProcessResult) {
  return querySchema.parse(jsonlRecords(result).find((record) => record.type === "query.result"));
}
export function waitingQuery(result: CliProcessResult) {
  return querySchema
    .extend({ status: z.literal("waiting"), interaction: z.object({ interactionId: z.string() }) })
    .parse(jsonlRecords(result).find((record) => record.type === "query.result"));
}
export function cliToolOutput(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const input = z
    .array(z.object({ type: z.string().optional(), output: z.unknown().optional() }))
    .parse(body.input);
  const last = input.findLast((item) => item.type === "function_call_output");
  if (!last) return undefined;
  const output = z.union([z.string(), z.array(z.object({ text: z.string() }))]).parse(last.output);
  const isError = typeof output !== "string" && output[0]?.text === "[tool_error]";
  // The Responses adapter carries isError as a separate leading metadata part.
  const text =
    typeof output === "string"
      ? output
      : output
          .filter((part, index) => index !== 0 || part.text !== "[tool_error]")
          .map((part) => part.text)
          .join("\n");
  // 错误标记承载的是失败模型内容，可以是纯文本；仅成功文件结果要求 JSON。
  if (isError) return { isError: true, content: text };
  return z.record(z.string(), z.unknown()).parse(JSON.parse(text));
}

export interface CliSdkRequest {
  readonly body: Record<string, unknown>;
  readonly authorization: string | undefined;
}
export type CliSdkReply =
  | string
  | {
      readonly name: string;
      readonly input: Readonly<Record<string, unknown>>;
      readonly callId?: string;
    };

export async function cliSdkServer(
  reply: (request: CliSdkRequest) => CliSdkReply | Promise<CliSdkReply>,
) {
  const requests: CliSdkRequest[] = [];
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ object: "list", data: [{ id: "mimo-v2.6-flash", object: "model" }] }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const record = {
        body: z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
        authorization: request.headers.authorization,
      };
      requests.push(record);
      const answer = await reply(record);
      const output =
        typeof answer === "string"
          ? [
              {
                id: `message-${requests.length}`,
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: answer, annotations: [] }],
              },
            ]
          : [
              {
                id: `reasoning-${requests.length}`,
                type: "reasoning",
                summary: [],
                content: [{ type: "reasoning_text", text: "PRIVATE_REPLAY_SENTINEL" }],
              },
              {
                id: `function-${requests.length}`,
                type: "function_call",
                call_id: answer.callId ?? `call-${requests.length}`,
                name: answer.name,
                arguments: JSON.stringify(answer.input),
                status: "completed",
              },
            ];
      const final = {
        id: `response-${requests.length}`,
        object: "response",
        status: "completed",
        model: "mimo-v2.6-flash",
        output,
        usage: {
          input_tokens: 8,
          output_tokens: 4,
          output_tokens_details: { reasoning_tokens: 1 },
        },
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [index, item] of output.entries()) {
        const initial = {
          ...item,
          status: "in_progress",
          ...(item.type === "message" || item.type === "reasoning" ? { content: [] } : {}),
          ...(item.type === "function_call" ? { arguments: "" } : {}),
        };
        const events = [
          { type: "response.output_item.added", output_index: index, item: initial },
          ...(item.type === "message"
            ? [
                {
                  type: "response.output_text.delta",
                  item_id: item.id,
                  output_index: index,
                  content_index: 0,
                  delta: typeof answer === "string" ? answer : "",
                },
              ]
            : []),
          { type: "response.output_item.done", output_index: index, item },
        ];
        for (const event of events)
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end(
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: final })}\n\ndata: [DONE]\n\n`,
      );
    })().catch((error: unknown) => {
      errors.push(error);
      response.writeHead(500);
      response.end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected local server address");
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    requests,
    errors,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
