import type { LogContext, LogInput, LogRecord } from "@agent-harness/logs/log-contract";
import { createLogs } from "@agent-harness/logs/logs";
import { describe, expect, it } from "vitest";
import { createLogRecord } from "../packages/logs/dist/internal/log-safety.js";

function capture(name = "safety") {
  const records: LogRecord[] = [];
  const logs = createLogs({
    outputs: [
      {
        id: "capture",
        minimumLevel: "debug",
        exporter: {
          export(record) {
            records.push(record);
          },
          async close() {},
        },
      },
    ],
  });
  return { logs, logger: logs.getLogger(name), records };
}

describe("log safety", () => {
  it("redacts complete secret values and secret-shaped keys across the whole record", async () => {
    const { logs, logger, records } = capture("sk-nameCredentialAbc");
    const hidden = [
      "nameCredentialAbc",
      "eventCredentialAbc",
      "contextCredentialAbc",
      "apiCredentialAbc",
      "authCredentialAbc",
      "passwordCredentialAbc",
      "secretCredentialAbc",
      "tokenCredentialAbc",
      "bearerCredentialAbc",
      "accessCredentialAbc",
      "refreshCredentialAbc",
      "keyCredentialAbc",
      "valueCredentialAbc",
    ];
    logger.child({ runId: "Bearer contextCredentialAbc" }).info("Bearer eventCredentialAbc", {
      nested: {
        API_Key: { raw: hidden[3] },
        AuThOrIzAtIoN: [hidden[4]],
        PASSWORD: hidden[5],
        "client.secret": { raw: hidden[6] },
        Token: [hidden[7]],
        bearer: hidden[8],
        "Access-Token": hidden[9],
        refresh_token: hidden[10],
        "Bearer keyCredentialAbc": hidden[11],
        "tvly-valueCredentialAbc": hidden[12],
        tokenCount: 123,
        inputTokens: 45,
        maxTokens: 256,
      },
    });
    const record = records[0];
    const json = JSON.stringify(record);
    for (const credential of hidden) expect(json).not.toContain(credential);
    expect(record.data?.nested).toMatchObject({ tokenCount: 123, inputTokens: 45, maxTokens: 256 });
    const nested = record.data?.nested as Record<string, unknown>;
    expect(typeof nested.API_Key).toBe("string");
    expect(typeof nested.AuThOrIzAtIoN).toBe("string");
    expect(typeof nested["client.secret"]).toBe("string");
    expect(typeof record.name).toBe("string");
    expect(typeof record.event).toBe("string");
    expect(typeof record.context.runId).toBe("string");
    await logs.close();
  });

  it("removes URL userinfo, encoded secret query values, Bearer credentials and known keys", async () => {
    const { logs, logger, records } = capture();
    const credentials = [
      "urlUserAbc",
      "urlPasswordAbc",
      "queryApiAbc",
      "queryRefreshAbc",
      "queryAccessAbc",
      "schemeUserAbc",
      "schemePasswordAbc",
      "bearerTextAbc",
      "sk-knownCredentialAbc",
      "tvly-knownCredentialAbc",
      "tp-mimoCredentialAbc",
      "ttp-mimoCredentialAbc",
    ];
    logger
      .child({
        operation: "https://urlUserAbc:urlPasswordAbc@example.test/path?api%5Fkey=queryApiAbc",
      })
      .warn("url.credentials", {
        endpoint:
          "https://urlUserAbc:urlPasswordAbc@example.test/path?api%5Fkey=queryApiAbc&refresh-token=queryRefreshAbc&tokenCount=18#ok",
        relative: "//schemeUserAbc:schemePasswordAbc@example.test/?accessToken=queryAccessAbc",
        text: "Bearer bearerTextAbc sk-knownCredentialAbc tvly-knownCredentialAbc tp-mimoCredentialAbc ttp-mimoCredentialAbc",
      });
    const record = records[0];
    const json = JSON.stringify(record);
    for (const credential of credentials) expect(json).not.toContain(credential);
    expect(record.data?.endpoint).toContain("example.test/path");
    expect(record.data?.endpoint).toContain("tokenCount=18");
    expect(record.context.operation).toContain("example.test/path");
    await logs.close();
  });

  it("projects Error data descriptors without exposing SDK bodies, messages, stacks or causes", async () => {
    const { logs, logger, records } = capture();
    class TransportError extends Error {}
    Object.defineProperty(TransportError.prototype, "name", { value: "TransportError" });
    Object.defineProperty(TransportError.prototype, "code", { value: "E_REMOTE" });
    const error = new TransportError("messageCredentialAbc", {
      cause: new Error("causeCredentialAbc"),
    });
    Object.assign(error, {
      request: { apiKey: "requestCredentialAbc" },
      response: { body: "responseCredentialAbc" },
    });
    logger.error("request.failed", { error });
    const projection = records[0].data?.error;
    expect(projection).toEqual({ name: "TransportError", code: "E_REMOTE" });
    const json = JSON.stringify(records[0]);
    for (const credential of [
      "messageCredentialAbc",
      "causeCredentialAbc",
      "requestCredentialAbc",
      "responseCredentialAbc",
    ]) {
      expect(json).not.toContain(credential);
    }
    await logs.close();
  });

  it("never invokes getters, toJSON, toString or special-object coercion", async () => {
    const { logs, logger, records } = capture();
    let calls = 0;
    const forbidden = () => {
      calls += 1;
      throw new Error("getterCredentialAbc");
    };
    const error = new Error("private message");
    for (const field of ["stack", "message", "name", "code", "cause", "toJSON"]) {
      Object.defineProperty(error, field, { configurable: true, get: forbidden });
    }
    const array = [1, 2];
    Object.defineProperty(array, "0", { enumerable: true, get: forbidden });
    Object.defineProperty(array, "toJSON", { get: forbidden });
    const object = Object.defineProperties(
      {},
      {
        field: { enumerable: true, get: forbidden },
        toJSON: { enumerable: true, get: forbidden },
        [Symbol.toStringTag]: { get: forbidden },
      },
    );
    const context = Object.defineProperties(
      { runId: "safe-run" },
      {
        operation: { enumerable: true, get: forbidden },
        step: { get: forbidden },
      },
    );
    const special = new Date();
    Object.defineProperty(special, "toJSON", { get: forbidden });
    logger.child(context).info("getter.boundary", { error, object, array, special });
    expect(calls).toBe(0);
    expect(records).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(records[0])).context).toEqual({ runId: "safe-run" });
    expect(calls).toBe(0);
    expect(typeof (records[0].data?.object as Record<string, unknown> | undefined)?.field).toBe(
      "string",
    );
    expect(Object.keys(records[0].data?.error as object)).toEqual(["name"]);
    expect(logs.getStatus().outputs[0].failureCount).toBe(0);
    await logs.close();
  });

  it("does not retain Error code objects or execute their serialization hooks", async () => {
    const { logs, logger, records } = capture();
    let calls = 0;
    const code = {
      value: "codeCredentialAbc",
      toJSON() {
        calls += 1;
        return this.value;
      },
    };
    const error = Object.assign(new Error("private"), { code });
    const safeName = Object.create(Error.prototype) as Error;
    Object.defineProperty(safeName, "name", { value: "Bearer errorNameCredentialAbc" });
    Object.defineProperty(safeName, "code", { value: "tvly-errorCodeCredentialAbc" });
    logger.error("error.code", { error, safeName });
    const json = JSON.stringify(records[0]);
    expect(json).not.toContain("codeCredentialAbc");
    expect(json).not.toContain("errorNameCredentialAbc");
    expect(json).not.toContain("errorCodeCredentialAbc");
    expect(calls).toBe(0);
    expect(records[0].data?.error).toEqual({ name: "Error" });
    await logs.close();
  });

  it("merges only whitelisted context data fields and snapshots bindings before caller mutation", async () => {
    const { logs, logger, records } = capture();
    const base = {
      runId: "run-original",
      queryId: "query-original",
      step: 2,
      password: "contextExtraAbc",
    };
    const parent = logger.child(base);
    const child = parent.child({ runId: "run-child", queryId: undefined, step: 3 });
    base.runId = "run-mutated";
    base.queryId = "query-mutated";
    parent.info("parent");
    child.info("child", { runId: "data-run" });
    for (const step of [-1, 1.25, Number.NaN, Number.POSITIVE_INFINITY]) {
      parent.child({ step }).info("invalid.step");
    }
    expect(records[0].context).toEqual({
      runId: "run-original",
      queryId: "query-original",
      step: 2,
    });
    expect(records[1].context).toEqual({ runId: "run-child", queryId: "query-original", step: 3 });
    expect(records[1].data?.runId).toBe("data-run");
    for (const record of records.slice(2)) expect(record.context.step).toBe(2);
    expect(JSON.stringify(records)).not.toContain("contextExtraAbc");
    expect(JSON.stringify(records)).not.toContain("run-mutated");
    await logs.close();
  });

  it("turns throwing and revoked Proxies into minimal JSON records and continues accepting writes", async () => {
    const { logs, logger, records } = capture();
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("proxyExceptionCredentialAbc");
        },
      },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    logger.child({ runId: "not-retained-in-fallback" }).error("proxy.failed", {
      partial: "not-retained-in-fallback",
      proxy,
    });
    logger.error("proxy.revoked", { proxy: revoked.proxy });
    logger.info("after.failure", { ok: true });
    expect(records).toHaveLength(3);
    for (const record of records.slice(0, 2)) {
      const parsed = JSON.parse(JSON.stringify(record));
      expect(parsed.context).toEqual({});
      expect(Object.keys(parsed.data)).toHaveLength(1);
      expect(Object.values(parsed.data).every((value) => typeof value === "string")).toBe(true);
      expect(record.instanceId).toBe(records[2].instanceId);
      expect(JSON.stringify(record)).not.toContain("proxyExceptionCredentialAbc");
      expect(JSON.stringify(record)).not.toContain("not-retained-in-fallback");
    }
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3]);
    expect(records[2].data).toEqual({ ok: true });
    expect(logs.getStatus().outputs[0].failureCount).toBe(0);
    await logs.close();
  });

  it("bounds cycles, binary, special objects, array length, object width and nesting", async () => {
    const { logs, logger, records } = capture();
    const cycle: Record<string, unknown> = { count: 2 };
    cycle.self = cycle;
    const binary = new TextEncoder().encode("binaryCredentialAbc");
    const wide = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`key${index}`, index]),
    );
    let deep: Record<string, unknown> = { hidden: "deepCredentialAbc" };
    for (let depth = 0; depth < 12; depth += 1) deep = { next: deep };
    logger.info("bounds", {
      cycle,
      binary,
      buffer: binary.buffer,
      view: new DataView(binary.buffer),
      special: new Map([["raw", "mapCredentialAbc"]]),
      array: Array.from({ length: 100 }, (_, index) => index),
      wide,
      deep,
      long: "a".repeat(20_000),
      bigint: 123n,
      nonFinite: Number.NaN,
    });
    const data = JSON.parse(JSON.stringify(records[0])).data;
    expect(data.cycle.count).toBe(2);
    expect(typeof data.cycle.self).toBe("string");
    expect(typeof data.binary).toBe("string");
    expect(typeof data.buffer).toBe("string");
    expect(typeof data.view).toBe("string");
    expect(typeof data.special).toBe("string");
    expect(data.array.length).toBeLessThanOrEqual(50);
    expect(data.array[0]).toBe(0);
    expect(Object.keys(data.wide).length).toBeLessThanOrEqual(50);
    expect(data.wide.key0).toBe(0);
    let node: unknown = data.deep;
    let depth = 0;
    while (node !== null && typeof node === "object") {
      depth += 1;
      node = (node as Record<string, unknown>).next;
    }
    expect(depth).toBeLessThanOrEqual(6);
    expect(typeof node).toBe("string");
    expect(data.long.length).toBeLessThanOrEqual(16_384);
    expect(data.long.length).toBeGreaterThan(1_000);
    const json = JSON.stringify(records[0]);
    for (const secret of ["binaryCredentialAbc", "deepCredentialAbc", "mapCredentialAbc"]) {
      expect(json).not.toContain(secret);
    }
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(65_536);
    await logs.close();
  });

  it("stops a broad shared graph within an overall work budget before emitting a summary", async () => {
    const { logs, logger, records } = capture();
    let descriptors = 0;
    let graph: Record<string, unknown> = { leaf: "safe-leaf" };
    for (let depth = 0; depth < 6; depth += 1) {
      const level = Object.fromEntries(
        Array.from({ length: 50 }, (_, index) => [`branch${index}`, graph]),
      );
      graph = new Proxy(level, {
        getOwnPropertyDescriptor(target, key) {
          descriptors += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
    }
    logger.info("graph.budget", graph);
    const data = JSON.parse(JSON.stringify(records[0])).data;
    expect(Object.keys(data)).toHaveLength(1);
    expect(Object.values(data).every((value) => typeof value === "string")).toBe(true);
    expect(descriptors).toBeLessThan(200_000);
    expect(descriptors).toBeGreaterThan(50);
    expect(new TextEncoder().encode(JSON.stringify(records[0])).length).toBeLessThan(1_024);
    await logs.close();
  });

  it("keeps oversized UTF-8 data and envelope inputs within one complete 64 KiB JSON record", () => {
    const context: LogContext = Object.fromEntries(
      [
        "operation",
        "sessionId",
        "agentId",
        "threadId",
        "queryId",
        "runId",
        "requestId",
        "toolCallId",
      ].map((key) => [key, "\u0000".repeat(20_000)]),
    );
    const record = createLogRecord(
      "internally-generated-instance",
      7,
      "\u0000".repeat(20_000),
      "\u0000".repeat(20_000),
      "info",
      context,
      { huge: Array.from({ length: 50 }, () => "界".repeat(16_384)) },
    );
    const json = JSON.stringify(record);
    const parsed = JSON.parse(json);
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(65_536);
    expect(parsed.instanceId).toBe("internally-generated-instance");
    expect(parsed.sequence).toBe(7);
    expect(parsed.name.length).toBeLessThanOrEqual(256);
    expect(parsed.event.length).toBeLessThanOrEqual(256);
    expect(
      Object.values(parsed.context).every(
        (value) => typeof value === "string" && value.length <= 256,
      ),
    ).toBe(true);
    expect(Object.keys(parsed.data)).toHaveLength(1);
    expect(typeof Object.values(parsed.data)[0]).toBe("string");
    expect(json).not.toContain("界");
  });

  it("does not leak URL userinfo when an oversized credential is truncated before its @", async () => {
    const { logs, logger, records } = capture();
    logger.info("long.url", {
      endpoint: `https://userCredentialAbc:${"p".repeat(20_000)}@example.test`,
    });
    const json = JSON.stringify(records[0]);
    expect(json).not.toContain("userCredentialAbc");
    expect(json).not.toContain("p".repeat(100));
    expect(typeof records[0].data?.endpoint).toBe("string");
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(65_536);
    await logs.close();
  });

  it("never coerces invalid runtime envelope values or trusts externally frozen contexts", () => {
    let calls = 0;
    const invalid = {
      toString() {
        calls += 1;
        return "coercionCredentialAbc";
      },
    };
    const context = Object.freeze({
      runId: "Bearer frozenContextCredentialAbc",
      step: -1,
      password: "frozenExtraCredentialAbc",
    });
    const record = createLogRecord(
      "instance",
      1,
      invalid as unknown as string,
      invalid as unknown as string,
      "info",
      context,
      {},
    );
    const json = JSON.stringify(record);
    expect(calls).toBe(0);
    expect(typeof record.name).toBe("string");
    expect(typeof record.event).toBe("string");
    expect(record.context.step).toBeUndefined();
    expect(record.context).not.toBe(context);
    for (const secret of [
      "coercionCredentialAbc",
      "frozenContextCredentialAbc",
      "frozenExtraCredentialAbc",
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  it("bounds cyclic Proxy prototype chains without invoking coercion or invalid event hooks", async () => {
    const { logs, logger, records } = capture();
    let prototypeReads = 0;
    let cyclic: object;
    cyclic = new Proxy(
      {},
      {
        getPrototypeOf() {
          prototypeReads += 1;
          return cyclic;
        },
      },
    );
    let coercions = 0;
    const invalidEvent = {
      toString() {
        coercions += 1;
        return "eventCoercionCredentialAbc";
      },
    };
    const invalidContext = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("contextProxyCredentialAbc");
        },
      },
    );
    logger.child(invalidContext).info(invalidEvent as unknown as string, { cyclic, ok: true });
    const record = records[0];
    expect(prototypeReads).toBeGreaterThan(0);
    expect(prototypeReads).toBeLessThanOrEqual(7);
    expect(coercions).toBe(0);
    expect(record.context).toEqual({});
    expect(typeof record.event).toBe("string");
    expect(typeof record.data?.cyclic).toBe("string");
    expect(record.data?.ok).toBe(true);
    const json = JSON.stringify(record);
    expect(json).not.toContain("eventCoercionCredentialAbc");
    expect(json).not.toContain("contextProxyCredentialAbc");
    expect(logs.getStatus().outputs[0].failureCount).toBe(0);
    await logs.close();
  });

  it("omits dangerous property names without prototype changes or hidden serialization calls", async () => {
    const { logs, logger, records } = capture();
    let calls = 0;
    const data: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(data, "__proto__", {
      enumerable: true,
      value: { polluted: "prototypeCredentialAbc" },
    });
    Object.defineProperty(data, "constructor", {
      enumerable: true,
      value: { prototype: { polluted: "constructorCredentialAbc" } },
    });
    data.prototype = { polluted: "prototypeFieldCredentialAbc" };
    Object.defineProperty(data, "toJSON", {
      enumerable: true,
      get() {
        calls += 1;
        return () => "serializationCredentialAbc";
      },
    });
    data.safe = "kept";
    data["k".repeat(50_000)] = "oversizedKeyValueCredentialAbc";
    logger.info("property.boundary", data);
    const json = JSON.stringify(records[0]);
    const parsed = JSON.parse(json);
    expect(parsed.data.safe).toBe("kept");
    expect(Object.hasOwn(parsed.data, "__proto__")).toBe(false);
    expect(Object.hasOwn(parsed.data, "constructor")).toBe(false);
    expect(Object.hasOwn(parsed.data, "prototype")).toBe(false);
    expect(Object.hasOwn(parsed.data, "toJSON")).toBe(false);
    expect(calls).toBe(0);
    for (const secret of [
      "prototypeCredentialAbc",
      "constructorCredentialAbc",
      "prototypeFieldCredentialAbc",
      "serializationCredentialAbc",
      "oversizedKeyValueCredentialAbc",
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await logs.close();
  });

  it("shares one deeply immutable snapshot across exporters without retaining mutable input references", async () => {
    const later: LogRecord[] = [];
    const attemptedMutations: boolean[] = [];
    const input = { nested: { count: 1, items: [{ ok: true }] } };
    const context = { runId: "safe-run" };
    const logs = createLogs({
      outputs: [
        {
          id: "mutating",
          minimumLevel: "debug",
          exporter: {
            export(record) {
              const nested = record.data?.nested as Record<string, unknown>;
              const items = nested.items as Record<string, unknown>[];
              attemptedMutations.push(
                Reflect.set(record, "event", "polluted"),
                Reflect.set(record.context, "runId", "polluted"),
                Reflect.set(record.data as object, "extra", "polluted"),
                Reflect.set(nested, "count", 99),
                Reflect.set(items, "0", { ok: false }),
                Reflect.set(items[0], "ok", false),
              );
              later.push(record);
            },
            async close() {},
          },
        },
        {
          id: "observing",
          minimumLevel: "debug",
          exporter: {
            export(record) {
              later.push(record);
            },
            async close() {},
          },
        },
      ],
    });
    logs
      .getLogger("immutable")
      .child(context)
      .info("snapshot", input as LogInput);
    input.nested.count = 42;
    input.nested.items[0].ok = false;
    context.runId = "caller-mutated";
    expect(attemptedMutations).toEqual([false, false, false, false, false, false]);
    expect(later).toHaveLength(2);
    expect(later[0]).toBe(later[1]);
    expect(later[1].data).toEqual({ nested: { count: 1, items: [{ ok: true }] } });
    expect(later[1].context.runId).toBe("safe-run");
    expect(later[1].event).toBe("snapshot");
    expect(later[1].data?.nested).not.toBe(input.nested);
    expect(Object.isFrozen(later[1])).toBe(true);
    expect(Object.isFrozen(later[1].context)).toBe(true);
    expect(Object.isFrozen(later[1].data)).toBe(true);
    expect(logs.getStatus().outputs.every((output) => output.failureCount === 0)).toBe(true);
    await logs.close();
  });
});
