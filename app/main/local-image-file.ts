import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkspacePath } from "./agent/subagent/workspace-path";

export type SupportedRasterMimeType = "image/png" | "image/jpeg" | "image/gif";

export const MAX_LOCAL_IMAGE_BYTES = 12 * 1024 * 1024;

export function resolveLocalImagePath(value: string, workspaceRoot?: string): string {
  if (value.startsWith("file://")) return fileURLToPath(value);
  if (isAbsolute(value) || !workspaceRoot) return value;
  return resolveWorkspacePath(workspaceRoot, value);
}

export function detectSupportedRasterMime(
  signature: Uint8Array,
): SupportedRasterMimeType | undefined {
  const isPng =
    signature.length >= 8 &&
    signature[0] === 0x89 &&
    signature[1] === 0x50 &&
    signature[2] === 0x4e &&
    signature[3] === 0x47 &&
    signature[4] === 0x0d &&
    signature[5] === 0x0a &&
    signature[6] === 0x1a &&
    signature[7] === 0x0a;
  if (isPng) return "image/png";

  const isJpeg =
    signature.length >= 3 &&
    signature[0] === 0xff &&
    signature[1] === 0xd8 &&
    signature[2] === 0xff;
  if (isJpeg) return "image/jpeg";

  const gifSignature =
    signature.length >= 6 ? Buffer.from(signature.subarray(0, 6)).toString("ascii") : "";
  if (gifSignature === "GIF87a" || gifSignature === "GIF89a") return "image/gif";
  return undefined;
}

export async function assertSupportedLocalImageFile(
  filePath: string,
): Promise<SupportedRasterMimeType> {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Image source is not a file.");
    if (info.size === 0) throw new Error("Image file is empty.");
    if (info.size > MAX_LOCAL_IMAGE_BYTES) {
      throw new Error("Image file exceeds the 12 MB export limit.");
    }
    const signature = Buffer.alloc(8);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    const mimeType = detectSupportedRasterMime(signature.subarray(0, bytesRead));
    if (!mimeType) {
      throw new Error("Unsupported image file content; expected PNG, JPEG, or GIF.");
    }
    return mimeType;
  } finally {
    await handle.close();
  }
}
