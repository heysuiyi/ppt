import { randomUUID } from "node:crypto";
import { createNodeCredentialProtection } from "@agent-harness/configuration/node-credentials";
import { describe, expect, it } from "vitest";

const windows = process.platform === "win32";

describe("Node credential protection", () => {
  it.skipIf(windows)("fails safely on unsupported platforms", async () => {
    const protection = createNodeCredentialProtection();
    expect(await protection.inspect()).toMatchObject({ state: "unavailable" });
    await expect(protection.encrypt("must-not-be-persisted")).rejects.toMatchObject({
      name: "NodeCredentialProtectionError",
      code: "UNAVAILABLE",
    });
  });

  it.skipIf(!windows)(
    "round-trips real CurrentUser DPAPI without accepting foreign ciphertext",
    async () => {
      const protection = createNodeCredentialProtection();
      expect(await protection.inspect()).toEqual({
        state: "secure",
        backend: "windows-dpapi-current-user",
      });
      const secret = `credential-${randomUUID()}-中文`;
      const first = await protection.encrypt(secret);
      const second = await protection.encrypt(secret);
      expect(Buffer.from(first).includes(Buffer.from(secret))).toBe(false);
      expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
      const reopened = createNodeCredentialProtection();
      expect(await reopened.decrypt(first)).toEqual({ result: secret, shouldReEncrypt: false });
      await expect(reopened.decrypt(Buffer.from("electron-ciphertext"))).rejects.toMatchObject({
        code: "UNSUPPORTED_CIPHERTEXT",
      });
      const tampered = Buffer.from(first);
      tampered[tampered.length - 1] ^= 1;
      await expect(reopened.decrypt(tampered)).rejects.toMatchObject({
        name: "NodeCredentialProtectionError",
        code: "PROTECTION_FAILED",
      });
    },
    60_000,
  );

  it.skipIf(!windows)(
    "drains an aborted in-flight DPAPI operation and returns only a safe error",
    async () => {
      const controller = new AbortController();
      const protection = createNodeCredentialProtection({ signal: controller.signal });
      const operation = protection.encrypt(`cancelled-${randomUUID()}`);
      const rejected = expect(operation).rejects.toMatchObject({
        name: "NodeCredentialProtectionError",
        code: "PROTECTION_FAILED",
        message: "Windows CurrentUser DPAPI credential protection failed.",
      });
      controller.abort(new Error("private cancellation reason"));
      await rejected;
    },
  );

  it("does not start protection operations after the owning scope is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const protection = createNodeCredentialProtection({ signal: controller.signal });
    expect(await protection.inspect()).toMatchObject({ state: "unavailable" });
    await expect(protection.encrypt("not-collected-for-storage")).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });
});
