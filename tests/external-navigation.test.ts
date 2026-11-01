import { describe, expect, it } from "vitest";

import { resolveExternalHttpUrl } from "../app/main/external-navigation";

describe("resolveExternalHttpUrl", () => {
  it("accepts HTTP and HTTPS links for the system browser", () => {
    expect(resolveExternalHttpUrl("https://example.com/docs?q=ppt")).toBe(
      "https://example.com/docs?q=ppt",
    );
    expect(resolveExternalHttpUrl("http://example.com/")).toBe("http://example.com/");
  });

  it("rejects application-local and executable protocols", () => {
    expect(resolveExternalHttpUrl("file:///tmp/index.html")).toBeNull();
    expect(resolveExternalHttpUrl("javascript:alert(1)")).toBeNull();
    expect(resolveExternalHttpUrl("not a url")).toBeNull();
  });
});
