import { createHash } from "node:crypto";
import { type ContentHash, contentHashSchema } from "@shared/presentation-lifecycle";

export function hashBytes(value: Uint8Array): ContentHash {
  return contentHashSchema.parse(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new Error("Lifecycle artifact values must be JSON serializable.");
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function hashArtifactValue(value: unknown): ContentHash {
  return hashBytes(Buffer.from(canonicalJson(value), "utf8"));
}
