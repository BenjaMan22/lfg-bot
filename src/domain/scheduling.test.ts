import { describe, expect, it } from "vitest";
import { rankNight, type Game, type SchedulingInput } from "./scheduling.js";
import type { NightDay } from "./timeblocks.js";

const H = 3600;
/** Day 0 runs 0..6 in "hour units" for readability; real code uses epoch seconds. */
const day = (dayIndex: number, hourCount: number): NightDay => ({
  dayIndex,
  startUtc: dayIndex * 100 * H,
  endUtc: dayIndex * 100 * H + hourCount * H,
});
const at = (d: NightDay, offset: number) => d.startUtc + offset * H;

const deepRock: Game = { id: 1, name: "Deep Rock", minPlayers: 4, maxPlayers: 4 };
const lethal: Game = { id: 2, name: "Lethal Company", minPlayers: 2, maxPlayers: 4 };
const solo: Game = { id: 3, name: "Solo Game", minPlayers: 1, maxPlayers: null };

function input(over: Partial<SchedulingInput> = {}): SchedulingInput {
  return {
    days: [day(0, 6)],
    minSessionHours: 2,
    games: [lethal],
    availability: new Map(),
    votes: new Map(),
    ...over,
  };
}

/** Everyone free for the same offsets, all voting for the same games. */
function everyone(
  d: NightDay,
  users: string[],
  offsets: number[],
  gameIds: number[],
): Pick<SchedulingInput, "availability" | "votes"> {
  return {
    availability: new Map(users.map((u) => [u, new Set(offsets.map((o) => at(d, o)))])),
    votes: new Map(users.map((u) => [u, new Set(gameIds)])),
  };
}

describe("rankNight", () => {
  it("returns nothing when nobody has responded", () => {
    expect(rankNight(input())).toEqual({ top: [], nearMisses: [] });
  });

  it("returns nothing when one person is free and the game needs two", () => {
    const d = day(0, 6);
    const result = rankNight(input(everyone(d, ["a"], [0, 1, 2], [2])));
    expect(result.top).toEqual([]);
    expect(result.nearMisses[0]).toMatchObject({ rosterSize: 1, shortfall: 1 });
  });

  it("suggests a window when enough people are free for all of it", () => {
    const d = day(0, 6);
    const result = rankNight(input(everyone(d, ["a", "b"], [0, 1, 2], [2])));
    expect(result.top).toHaveLength(1);
    expect(result.top[0]).toMatchObject({
      game: lethal,
      startUtc: at(d, 0),
      endUtc: at(d, 3),
      oversubscribed: false,
    });
    expect(result.top[0].roster.sort()).toEqual(["a", "b"]);
  });

  it("excludes a run shorter than the minimum session", () => {
    const d = day(0, 6);
    const result = rankNight(
      input({ ...everyone(d, ["a", "b"], [0], [2]), minSessionHours: 2 }),
    );
    expect(result.top).toEqual([]);
  });

  it("excludes someone who is free for only part of the run", () => {
    const d = day(0, 6);
    const result = rankNight(
      input({
        availability: new Map([
          ["a", new Set([at(d, 0), at(d, 1), at(d, 2)])],
          ["b", new Set([at(d, 0), at(d, 1), at(d, 2)])],
          ["c", new Set([at(d, 0)])],
        ]),
        votes: new Map([
          ["a", new Set([2])],
          ["b", new Set([2])],
          ["c", new Set([2])],
        ]),
      }),
    );
    expect(result.top[0].roster.sort()).toEqual(["a", "b"]);
  });

  it("excludes someone who did not vote for the game", () => {
    const d = day(0, 6);
    const result = rankNight(
      input({
        availability: new Map([
          ["a", new Set([at(d, 0), at(d, 1)])],
          ["b", new Set([at(d, 0), at(d, 1)])],
          ["c", new Set([at(d, 0), at(d, 1)])],
        ]),
        votes: new Map([
          ["a", new Set([2])],
          ["b", new Set([2])],
          ["c", new Set([1])],
        ]),
      }),
    );
    expect(result.top[0].roster.sort()).toEqual(["a", "b"]);
  });

  it("reports a roster below min_players as a near miss, never a suggestion", () => {
    const d = day(0, 6);
    const result = rankNight(
      input({ ...everyone(d, ["a", "b", "c"], [0, 1, 2], [1]), games: [deepRock] }),
    );
    expect(result.top).toEqual([]);
    expect(result.nearMisses[0]).toMatchObject({ game: deepRock, rosterSize: 3, shortfall: 1 });
  });

  it("keeps a roster above max_players but flags it", () => {
    const d = day(0, 6);
    const result = rankNight(
      input(everyone(d, ["a", "b", "c", "d", "e"], [0, 1, 2], [2])),
    );
    expect(result.top[0].oversubscribed).toBe(true);
  });

  it("never flags a game with no maximum", () => {
    const d = day(0, 6);
    const result = rankNight(
      input({ ...everyone(d, ["a", "b", "c"], [0, 1, 2], [3]), games: [solo] }),
    );
    expect(result.top[0].oversubscribed).toBe(false);
  });

  it("prefers more players over a longer window", () => {
    const d = day(0, 6);
    const result = rankNight(
      input({
        games: [lethal, solo],
        availability: new Map([
          ["a", new Set([at(d, 0), at(d, 1), at(d, 2), at(d, 3)])],
          ["b", new Set([at(d, 2), at(d, 3)])],
        ]),
        votes: new Map([
          ["a", new Set([2, 3])],
          ["b", new Set([2, 3])],
        ]),
      }),
    );
    expect(result.top[0].roster).toHaveLength(2);
  });

  it("prefers the longer window when player counts tie", () => {
    const d = day(0, 6);
    const result = rankNight(input(everyone(d, ["a", "b"], [0, 1, 2, 3], [2])));
    expect(result.top[0].endUtc - result.top[0].startUtc).toBe(4 * H);
  });

  it("prefers the earlier start when players and length tie", () => {
    const d = day(0, 6);
    const result = rankNight(
      input({
        // Free 0-2 and 4-6, so two equal two-hour runs exist.
        availability: new Map([
          ["a", new Set([at(d, 0), at(d, 1), at(d, 4), at(d, 5)])],
          ["b", new Set([at(d, 0), at(d, 1), at(d, 4), at(d, 5)])],
        ]),
        votes: new Map([
          ["a", new Set([2])],
          ["b", new Set([2])],
        ]),
      }),
    );
    expect(result.top[0].startUtc).toBe(at(d, 0));
  });

  it("keeps only the best window per day and game", () => {
    const d = day(0, 6);
    const result = rankNight(input(everyone(d, ["a", "b"], [0, 1, 2, 3], [2])));
    expect(result.top).toHaveLength(1);
  });

  it("prefers three different days over three slices of one evening", () => {
    const days = [day(0, 6), day(1, 6), day(2, 6)];
    const availability = new Map<string, Set<number>>();
    const votes = new Map<string, Set<number>>();
    for (const user of ["a", "b"]) {
      availability.set(
        user,
        new Set(days.flatMap((d) => [at(d, 0), at(d, 1), at(d, 2)])),
      );
      votes.set(user, new Set([2, 3]));
    }
    const result = rankNight(input({ days, games: [lethal, solo], availability, votes }));
    expect(new Set(result.top.map((s) => s.dayIndex)).size).toBe(3);
  });

  it("backfills from the same day when there are not three days available", () => {
    const d = day(0, 6);
    const result = rankNight(
      input({ ...everyone(d, ["a", "b"], [0, 1, 2], [2, 3]), games: [lethal, solo] }),
    );
    expect(result.top).toHaveLength(2);
    expect(result.top.every((s) => s.dayIndex === 0)).toBe(true);
  });

  it("returns at most three suggestions", () => {
    const days = [day(0, 6), day(1, 6), day(2, 6), day(3, 6)];
    const availability = new Map<string, Set<number>>();
    const votes = new Map<string, Set<number>>();
    for (const user of ["a", "b"]) {
      availability.set(
        user,
        new Set(days.flatMap((d) => [at(d, 0), at(d, 1), at(d, 2)])),
      );
      votes.set(user, new Set([2, 3]));
    }
    const result = rankNight(input({ days, games: [lethal, solo], availability, votes }));
    expect(result.top).toHaveLength(3);
  });

  it("ranks near misses by smallest shortfall first", () => {
    const d = day(0, 6);
    const almost: Game = { id: 4, name: "Almost", minPlayers: 3, maxPlayers: null };
    const distant: Game = { id: 5, name: "Distant", minPlayers: 8, maxPlayers: null };
    const result = rankNight(
      input({
        games: [almost, distant],
        ...everyone(d, ["a", "b"], [0, 1, 2], [4, 5]),
      }),
    );
    expect(result.top).toEqual([]);
    expect(result.nearMisses[0].game).toEqual(almost);
  });

  it("treats users in different timezones as overlapping when the UTC hour matches", () => {
    const d = day(0, 6);
    // Three users picked "8pm" in three zones; only two produced the same instant.
    const result = rankNight(
      input({
        availability: new Map([
          ["chicago", new Set([at(d, 0), at(d, 1)])],
          ["newyork", new Set([at(d, 0), at(d, 1)])],
          ["london", new Set([at(d, 4), at(d, 5)])],
        ]),
        votes: new Map([
          ["chicago", new Set([2])],
          ["newyork", new Set([2])],
          ["london", new Set([2])],
        ]),
      }),
    );
    expect(result.top[0].roster.sort()).toEqual(["chicago", "newyork"]);
  });

  it("ignores availability hours that are not part of any day", () => {
    const d = day(0, 6);
    const result = rankNight(
      input({
        availability: new Map([
          ["a", new Set([at(d, 0), at(d, 1), 999_999 * H])],
          ["b", new Set([at(d, 0), at(d, 1)])],
        ]),
        votes: new Map([
          ["a", new Set([2])],
          ["b", new Set([2])],
        ]),
      }),
    );
    expect(result.top[0].endUtc).toBe(at(d, 2));
  });

  it("prefers the more-voted game when players, length and start all tie", () => {
    const d = day(0, 6);
    const popular: Game = { id: 6, name: "Popular", minPlayers: 2, maxPlayers: null };
    const niche: Game = { id: 7, name: "Niche", minPlayers: 2, maxPlayers: null };
    const result = rankNight(input({
      days: [day(0, 2)],
      games: [niche, popular],
      availability: new Map([
        ["a", new Set([at(d, 0), at(d, 1)])],
        ["b", new Set([at(d, 0), at(d, 1)])],
        ["c", new Set()],
      ]),
      votes: new Map([
        ["a", new Set([6, 7])],
        ["b", new Set([6, 7])],
        ["c", new Set([6])],
      ]),
    }));
    expect(result.top[0].game).toEqual(popular);
  });

  it("returns no near misses once anything is viable", () => {
    const d = day(0, 6);
    const result = rankNight(input({
      games: [lethal, deepRock],
      ...everyone(d, ["a", "b"], [0, 1, 2], [1, 2]),
    }));
    expect(result.top.length).toBeGreaterThan(0);
    expect(result.nearMisses).toEqual([]);
  });

  it("prefers the longer window for a near miss when shortfall and roster size tie", () => {
    const d = day(0, 6);
    const result = rankNight(input(everyone(d, ["a"], [0, 1, 2, 3], [2])));
    expect(result.top).toEqual([]);
    expect(result.nearMisses[0]).toMatchObject({ startUtc: at(d, 0), endUtc: at(d, 4) });
  });

  it("returns nothing when minSessionHours is not a positive number", () => {
    const d = day(0, 6);
    const result = rankNight(
      input({ ...everyone(d, ["a", "b"], [0, 1, 2], [2]), minSessionHours: 0 }),
    );
    expect(result).toEqual({ top: [], nearMisses: [] });
  });
});
