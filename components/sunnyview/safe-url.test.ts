import { describe, expect, it } from "vitest";
import { safeHttpsUrl } from "./safe-url";

describe("safeHttpsUrl", () => {
  it("accepts https urls", () => {
    expect(safeHttpsUrl("https://example.com/panel?a=1")).toBe("https://example.com/panel?a=1");
  });
  it.each(["javascript:alert(1)", "http://example.com", "data:text/html,x", "ftp://x.com", "not a url", "", "//evil.com"])(
    "rejects %s",
    (u) => expect(safeHttpsUrl(u)).toBeNull(),
  );
  it("rejects null and undefined", () => {
    expect(safeHttpsUrl(null)).toBeNull();
    expect(safeHttpsUrl(undefined)).toBeNull();
  });
});
