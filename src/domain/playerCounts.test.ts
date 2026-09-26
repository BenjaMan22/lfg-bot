import { describe, expect, it } from "vitest";
import { PlayerCountError, parseMaxPlayers, playerCountLabel } from "./playerCounts.js";

describe("parseMaxPlayers", () => {
  it("treats blank as any number of players", () => {
    expect(parseMaxPlayers("")).toBeNull();
    expect(parseMaxPlayers("   ")).toBeNull();
  });

  it("keeps a whole number the host supplied", () => {
    expect(parseMaxPlayers("4")).toBe(4);
    expect(parseMaxPlayers(" 1 ")).toBe(1);
  });

  it("rejects anything that is not a whole number of at least one", () => {
    expect(() => parseMaxPlayers("0")).toThrow(PlayerCountError);
    expect(() => parseMaxPlayers("-2")).toThrow(PlayerCountError);
    expect(() => parseMaxPlayers("2.5")).toThrow(PlayerCountError);
    expect(() => parseMaxPlayers("four")).toThrow(PlayerCountError);
  });

  it("explains the problem in terms the host can act on", () => {
    expect(() => parseMaxPlayers("four")).toThrow(/whole number/i);
    expect(() => parseMaxPlayers("four")).toThrow(/blank/i);
  });
});

describe("playerCountLabel", () => {
  it("says any number when there is no maximum", () => {
    expect(playerCountLabel(null)).toBe("any number of players");
  });

  it("says up to the maximum", () => {
    expect(playerCountLabel(4)).toBe("up to 4 players");
  });

  it("does not say 'up to 1 players' for a one-player game", () => {
    expect(playerCountLabel(1)).toBe("1 player");
  });
});
