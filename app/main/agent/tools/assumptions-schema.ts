import { z } from "zod";

/** Models often pass a single string; coerce to string[]. */
export const assumptionsSchema = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : undefined;
  }
  return undefined;
}, z.array(z.string()).optional());
