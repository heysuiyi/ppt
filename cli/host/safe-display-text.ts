/** Pure display protection; not key parsing, HTML sanitization, or credential redaction. */
export function escapeDisplayControls(text: string): string {
  return text.replace(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
    (character) => {
      const code = character.codePointAt(0)!;
      if (code === 0x1b) return "\\x1b";
      if (code === 0x07) return "\\a";
      if (code === 0x08) return "\\b";
      if (code === 0x0d) return "\\r";
      return `\\u${code.toString(16).padStart(4, "0")}`;
    },
  );
}
