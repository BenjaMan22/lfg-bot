import { describe, expect, it } from "vitest";
import { eventName, hasAlreadyStarted } from "./events.js";
import type { Game, Suggestion } from "../domain/scheduling.js";

/**
 * createScheduledEvent itself is not covered here: it talks to a real
 * discord.js Client (guilds.fetch, scheduledEvents.create), and that class
 * carries private fields, so it cannot be faked with a plain object without
 * an `as`/`any` cast to force the type through — which this codebase
 * disallows. Its two decisions that don't require a live Client — the name
 * truncation and the already-started guard — are extracted as eventName and
 * hasAlreadyStarted below and tested directly; the rest is exercised by
 * reading createScheduledEvent, which is a thin, linear wrapper around them.
 */

const game: Game = { id: 1, name: "Deep Rock Galactic", minPlayers: 2, maxPlayers: 4 };

function suggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    dayIndex: 0,
    startUtc: 2_000_000,
    endUtc: 2_003_600,
    game,
    roster: ["u1", "u2"],
    oversubscribed: false,
    ...overrides,
  };
}

describe("eventName", () => {
  it("joins the night title and game name", () => {
    expect(eventName({ title: "Friday Night" }, suggestion())).toBe(
      "Friday Night: Deep Rock Galactic",
    );
  });

  it("leaves a name at or under the 100-character limit untouched", () => {
    const title = "T".repeat(80);
    const name = eventName({ title }, suggestion());
    expect(name).toBe(`${title}: Deep Rock Galactic`);
    expect(name.length).toBeLessThanOrEqual(100);
  });

  it("truncates a name over Discord's 100-character Scheduled Event limit", () => {
    const title = "T".repeat(80);
    const longGame: Game = { ...game, name: "A".repeat(60) };
    const name = eventName({ title }, suggestion({ game: longGame }));
    expect(name.length).toBe(100);
    expect(name.endsWith("…")).toBe(true);
    expect(name.startsWith(`${title}: `)).toBe(true);
  });
});

describe("hasAlreadyStarted", () => {
  it("is false while the window is still in the future", () => {
    expect(hasAlreadyStarted(suggestion({ startUtc: 2_000_000 }), 1_999_999)).toBe(false);
  });

  it("is true once the window's start has passed", () => {
    expect(hasAlreadyStarted(suggestion({ startUtc: 2_000_000 }), 2_000_001)).toBe(true);
  });

  it("is true at the exact start instant, since Discord rejects that too", () => {
    expect(hasAlreadyStarted(suggestion({ startUtc: 2_000_000 }), 2_000_000)).toBe(true);
  });
});
