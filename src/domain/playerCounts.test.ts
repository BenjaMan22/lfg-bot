import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_PLAYERS,
  PlayerCountError,
  parseMaxPlayers,
  parsePlayerCounts,
  playerCountLabel,
} from "./playerCounts.js";

describe("parsePlayerCounts", () => {
  it("defaults a blank minimum, so nobody is blocked on a number they don't care about", () => {
    expect(parsePlayerCounts("", "")).toEqual({ min: DEFAULT_MIN_PLAYERS, max: null });
  });

  it("treats whitespace as blank", () => {
    expect(parsePlayerCounts("   ", "  ")).toEqual({ min: DEFAULT_MIN_PLAYERS, max: null });
  });

  it("defaults to 1, so a solo session is still a night worth scheduling", () => {
    // The minimum is the engine's quorum, so 1 means a single interested
    // person is enough to schedule. That is deliberate: an evening worth
    // putting on the calendar shouldn't be blocked because nobody else has
    // answered yet. A game that genuinely needs a group still says so.
    expect(DEFAULT_MIN_PLAYERS).toBe(1);
  });

  it("keeps a minimum the host did supply", () => {
    expect(parsePlayerCounts("4", "")).toEqual({ min: 4, max: null });
  });

  it("keeps both counts when both are supplied", () => {
    expect(parsePlayerCounts("2", "4")).toEqual({ min: 2, max: 4 });
  });

  it("allows a maximum with a defaulted minimum", () => {
    expect(parsePlayerCounts("", "4")).toEqual({ min: DEFAULT_MIN_PLAYERS, max: 4 });
  });

  it("rejects a minimum that is not a whole number", () => {
    expect(() => parsePlayerCounts("two", "")).toThrow(PlayerCountError);
    expect(() => parsePlayerCounts("2.5", "")).toThrow(PlayerCountError);
  });

  it("rejects a minimum below one", () => {
    expect(() => parsePlayerCounts("0", "")).toThrow(PlayerCountError);
  });

  it("rejects a maximum below the minimum", () => {
    expect(() => parsePlayerCounts("4", "2")).toThrow(PlayerCountError);
  });

  it("rejects a maximum below a defaulted minimum", () => {
    expect(() => parsePlayerCounts("", "0")).toThrow(PlayerCountError);
  });

  it("explains the problem in terms the host can act on", () => {
    expect(() => parsePlayerCounts("two", "")).toThrow(/whole number/i);
  });
});

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
