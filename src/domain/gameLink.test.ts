import { describe, expect, it } from "vitest";
import { GameLinkError, parseGameLink } from "./gameLink.js";

describe("parseGameLink", () => {
  it("accepts a valid https url", () => {
    expect(parseGameLink("https://store.steampowered.com/app/548430")).toBe(
      "https://store.steampowered.com/app/548430",
    );
  });

  it("accepts a valid http url", () => {
    expect(parseGameLink("http://example.com/game")).toBe("http://example.com/game");
  });

  it("treats an empty string as no link", () => {
    expect(parseGameLink("")).toBeNull();
  });

  it("treats whitespace-only input as no link", () => {
    expect(parseGameLink("   ")).toBeNull();
  });

  it("trims surrounding whitespace before validating", () => {
    expect(parseGameLink("  https://example.com  ")).toBe("https://example.com");
  });

  it("rejects text that isn't a url", () => {
    expect(() => parseGameLink("not a link")).toThrow(GameLinkError);
  });

  it("rejects a non-http(s) scheme", () => {
    expect(() => parseGameLink("ftp://example.com/file")).toThrow(GameLinkError);
  });
});
