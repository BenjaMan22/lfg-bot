# Picker-Based Create Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the free-text Days, Hours and Deadline fields of `/gamenight create` with dropdowns, derive the lock time from the first chosen day, and remove minimum player counts everywhere.

**Architecture:** Picker option lists and the start+length → window conversion live in a new pure module, `src/domain/pickers.ts`, alongside the existing pure `timeblocks.ts` and `scheduling.ts`. The create modal renders those options and its submit handler feeds the result into the unchanged `expandDays`, so ranking, rendering and the lock sweep keep working untouched. Removing minimum players deletes near-miss logic from the engine and the renderer.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), discord.js 14.27, luxon, node:sqlite, vitest.

**Spec:** `docs/superpowers/specs/2026-09-26-picker-create-form-design.md`

## Global Constraints

- ESM with NodeNext resolution: every relative import carries a `.js` extension even though the source is `.ts`.
- TypeScript `strict: true`. No `any`, no `@ts-ignore`, no `as` cast used to silence an error. (Row-shape casts on `db.prepare(...).get()` follow the existing repository pattern and are fine.)
- `src/domain/` imports nothing from `discord.js` and nothing from `src/db/`. `src/discord/render.ts` imports nothing from `src/db/`.
- `PollView` stays a discriminated union on `status`; do not widen it or cast around it.
- The nights repository's write functions are already transaction-wrapped; do not wrap them again.
- `npm run typecheck` checks test files too (via `tsconfig.test.json`). A stale test fixture is a typecheck failure, not just a test failure.
- Discord limits: 25 options per select menu; 5 components per modal.
- Days: at most `MAX_DAYS` (5), chosen from the next 25 days. Start time: noon to 11:30pm every 30 minutes. Length: 2 to 12 hours every 30 minutes.
- Lock time: `LOCK_LEAD_SECONDS = 3600` before the first chosen day's window starts.
- `games.min_players` stays in the schema and is always written as `1`. Do not drop or migrate the column.
- Slash-command definitions do not change; `npm run deploy` is not needed.
- Commit messages end with a blank line then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Verification commands** used throughout:
- `npx vitest run <file>` — one test file
- `npm run typecheck` — main code and tests
- `npx vitest run` — full suite
- `npm run build` — production build

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/domain/pickers.ts` | Create | Pure picker option lists, start+length → window, lock time |
| `src/domain/pickers.test.ts` | Create | Tests for the above |
| `src/domain/playerCounts.ts` | Modify | Max-only parsing and the shared "up to N players" label |
| `src/domain/scheduling.ts` | Modify | Ranking without a minimum; near misses removed |
| `src/domain/timeblocks.ts` | Modify | Free-text parsers removed; window/slot/label helpers stay |
| `src/db/repos/games.ts` | Modify | `addGame` without `minPlayers`; always writes `min_players = 1` |
| `src/interactions/gamenightCreate.ts` | Modify | Picker modal and its submit handler |
| `src/interactions/games.ts` | Modify | `/games add` form without a minimum |
| `src/interactions/respond.ts` | Modify | Suggest-a-game form without a minimum; vote-select labels |
| `src/interactions/setup.ts` | Modify | Setup-select labels |
| `src/commands/games.ts` | Modify | `/games list` labels |
| `src/commands/gamenight.ts` | Modify | Passes timezone and time to the modal builder |
| `src/discord/render.ts` | Modify | No near misses; new failure and "nothing yet" copy; "Picks the night" |
| `README.md` | Modify | Command reference and walkthrough |

---

## Task 1: Picker options module

**Files:**
- Create: `src/domain/pickers.ts`
- Test: `src/domain/pickers.test.ts`

**Interfaces:**
- Consumes: `MAX_WINDOW_HOURS`, `DayWindow`, `NightDay`, `expandDays` from `src/domain/timeblocks.ts` (already exist).
- Produces:
  - `MIN_SESSION_HOURS: number` (= 2)
  - `LOCK_LEAD_SECONDS: number` (= 3600)
  - `SELECT_OPTION_LIMIT: number` (= 25)
  - `interface PickerOption<T> { value: T; label: string; description?: string }`
  - `dayOptions(tz: string, now: DateTime, count?: number): PickerOption<string>[]` — values are ISO dates (`"2026-09-26"`)
  - `START_TIME_OPTIONS: PickerOption<number>[]` — values are minutes since local midnight
  - `LENGTH_OPTIONS: PickerOption<number>[]` — values are minutes
  - `windowFromStartAndLength(startMinutes: number, lengthMinutes: number): DayWindow`
  - `lockTimeFor(days: NightDay[]): number` — epoch seconds; `days` must be non-empty and sorted

- [ ] **Step 1: Write the failing tests**

Create `src/domain/pickers.test.ts`:

```ts
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  LENGTH_OPTIONS,
  LOCK_LEAD_SECONDS,
  MIN_SESSION_HOURS,
  SELECT_OPTION_LIMIT,
  START_TIME_OPTIONS,
  dayOptions,
  lockTimeFor,
  windowFromStartAndLength,
} from "./pickers.js";
import { MAX_WINDOW_HOURS, expandDays } from "./timeblocks.js";

const CHI = "America/Chicago";
// Saturday afternoon.
const NOW = DateTime.fromISO("2026-09-26T15:00:00", { zone: CHI });

describe("dayOptions", () => {
  it("offers a full select's worth of days", () => {
    expect(dayOptions(CHI, NOW)).toHaveLength(SELECT_OPTION_LIMIT);
  });

  it("starts today, in the host's timezone", () => {
    expect(dayOptions(CHI, NOW)[0]).toEqual({
      value: "2026-09-26",
      label: "Sat Sep 26",
      description: "Today",
    });
  });

  it("uses the host's date, not UTC's, late in the evening", () => {
    // 10pm Saturday in Chicago is already Sunday in UTC.
    const late = DateTime.fromISO("2026-09-26T22:00:00", { zone: CHI });
    expect(dayOptions(CHI, late)[0].value).toBe("2026-09-26");
  });

  it("marks tomorrow, and nothing after it", () => {
    const options = dayOptions(CHI, NOW);
    expect(options[1].description).toBe("Tomorrow");
    expect(options.slice(2).every((o) => o.description === undefined)).toBe(true);
  });

  it("runs through a month boundary without skipping or repeating a day", () => {
    const values = dayOptions(CHI, NOW).map((o) => o.value);
    expect(values).toContain("2026-09-30");
    expect(values).toContain("2026-10-01");
    expect(new Set(values).size).toBe(values.length);
  });

  it("gives one option per calendar day across a DST change", () => {
    // US DST ends 2026-11-01, a 25-hour day in Chicago.
    const start = DateTime.fromISO("2026-10-30T12:00:00", { zone: CHI });
    expect(dayOptions(CHI, start, 5).map((o) => o.value)).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
    ]);
  });
});

describe("START_TIME_OPTIONS", () => {
  it("runs from noon to 11:30pm every half hour", () => {
    expect(START_TIME_OPTIONS).toHaveLength(24);
    expect(START_TIME_OPTIONS[0]).toEqual({ value: 12 * 60, label: "12pm" });
    expect(START_TIME_OPTIONS[1]).toEqual({ value: 12 * 60 + 30, label: "12:30pm" });
    expect(START_TIME_OPTIONS.at(-1)).toEqual({ value: 23 * 60 + 30, label: "11:30pm" });
  });

  it("fits in one Discord select", () => {
    expect(START_TIME_OPTIONS.length).toBeLessThanOrEqual(SELECT_OPTION_LIMIT);
  });
});

describe("LENGTH_OPTIONS", () => {
  it("runs from one session to the longest window, every half hour", () => {
    expect(LENGTH_OPTIONS).toHaveLength(21);
    expect(LENGTH_OPTIONS[0]).toEqual({ value: MIN_SESSION_HOURS * 60, label: "2 hours" });
    expect(LENGTH_OPTIONS[1]).toEqual({ value: 150, label: "2½ hours" });
    expect(LENGTH_OPTIONS.at(-1)).toEqual({ value: MAX_WINDOW_HOURS * 60, label: "12 hours" });
  });

  it("fits in one Discord select", () => {
    expect(LENGTH_OPTIONS.length).toBeLessThanOrEqual(SELECT_OPTION_LIMIT);
  });
});

describe("windowFromStartAndLength", () => {
  it("ends later the same evening", () => {
    expect(windowFromStartAndLength(19 * 60 + 30, 210)).toEqual({
      startMinutes: 1170,
      endMinutes: 1380,
    });
  });

  it("wraps past midnight", () => {
    expect(windowFromStartAndLength(22 * 60, 4 * 60)).toEqual({
      startMinutes: 1320,
      endMinutes: 120,
    });
  });

  it("wraps exactly to midnight", () => {
    expect(windowFromStartAndLength(12 * 60, 12 * 60)).toEqual({
      startMinutes: 720,
      endMinutes: 0,
    });
  });

  it("expands a wrapped window into the next morning", () => {
    const [day] = expandDays(
      ["2026-09-26"],
      windowFromStartAndLength(22 * 60, 4 * 60),
      CHI,
    );
    expect(DateTime.fromSeconds(day.endUtc, { zone: CHI }).toFormat("yyyy-MM-dd H:mm")).toBe(
      "2026-09-27 2:00",
    );
  });
});

describe("lockTimeFor", () => {
  it("locks an hour before the first day starts", () => {
    const days = expandDays(
      ["2026-09-28", "2026-09-29"],
      windowFromStartAndLength(19 * 60, 180),
      CHI,
    );
    expect(LOCK_LEAD_SECONDS).toBe(3600);
    expect(lockTimeFor(days)).toBe(days[0].startUtc - LOCK_LEAD_SECONDS);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/pickers.test.ts`
Expected: FAIL — `Cannot find module './pickers.js'`.

- [ ] **Step 3: Implement the module**

Create `src/domain/pickers.ts`:

```ts
import { DateTime } from "luxon";
import { MAX_WINDOW_HOURS, type DayWindow, type NightDay } from "./timeblocks.js";

/**
 * Every night ranks runs of at least this many hours. Fixed rather than a
 * form field: it is a detail of how the engine searches, not a decision the
 * host has context to make. It is also the shortest option in the length
 * picker, so a chosen window can never be too short to hold one session.
 */
export const MIN_SESSION_HOURS = 2;

/**
 * How long before the first chosen day starts the bot locks the night in —
 * enough notice for the winning roster to actually show up.
 */
export const LOCK_LEAD_SECONDS = 3600;

/** Discord's hard limit on the number of options in one select menu. */
export const SELECT_OPTION_LIMIT = 25;

const MINUTES_PER_DAY = 24 * 60;
const STEP_MINUTES = 30;
const FIRST_START_MINUTES = 12 * 60;
const LAST_START_MINUTES = 23 * 60 + 30;

/** One entry in a dropdown: what is stored, and what the host sees. */
export interface PickerOption<T> {
  value: T;
  label: string;
  description?: string;
}

/**
 * Today and the following days, as calendar dates in the host's timezone.
 * Built from the host's local midnight rather than a fixed number of seconds,
 * so a DST change never skips or repeats a date.
 */
export function dayOptions(
  tz: string,
  now: DateTime,
  count: number = SELECT_OPTION_LIMIT,
): PickerOption<string>[] {
  const today = now.setZone(tz).startOf("day");
  return Array.from({ length: count }, (_, i) => {
    const date = today.plus({ days: i });
    const option: PickerOption<string> = {
      value: date.toISODate()!,
      label: date.toFormat("ccc LLL d"),
    };
    if (i === 0) option.description = "Today";
    else if (i === 1) option.description = "Tomorrow";
    return option;
  });
}

/** `6pm`, or `6:30pm` off the hour. */
function clockLabel(minutes: number): string {
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const meridiem = hour24 < 12 ? "am" : "pm";
  return minute === 0
    ? `${hour12}${meridiem}`
    : `${hour12}:${String(minute).padStart(2, "0")}${meridiem}`;
}

/** `2 hours`, or `2½ hours` for a half. */
function lengthLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} hours` : `${hours}½ hours`;
}

function steps(from: number, to: number): number[] {
  const values: number[] = [];
  for (let v = from; v <= to; v += STEP_MINUTES) values.push(v);
  return values;
}

/**
 * Noon to 11:30pm. A select holds 25 options, so a whole day at half-hour
 * precision cannot fit; afternoon-and-evening is where game nights happen.
 */
export const START_TIME_OPTIONS: PickerOption<number>[] = steps(
  FIRST_START_MINUTES,
  LAST_START_MINUTES,
).map((minutes) => ({ value: minutes, label: clockLabel(minutes) }));

/**
 * From one session to the longest window a night may cover. Choosing a length
 * rather than an end time means a window that runs past midnight needs no
 * special handling, and a window too short or too long cannot be picked.
 */
export const LENGTH_OPTIONS: PickerOption<number>[] = steps(
  MIN_SESSION_HOURS * 60,
  MAX_WINDOW_HOURS * 60,
).map((minutes) => ({ value: minutes, label: lengthLabel(minutes) }));

/**
 * The start-and-length the host picked, as the start/end window `expandDays`
 * already understands. An end at or before the start means past midnight.
 */
export function windowFromStartAndLength(
  startMinutes: number,
  lengthMinutes: number,
): DayWindow {
  return { startMinutes, endMinutes: (startMinutes + lengthMinutes) % MINUTES_PER_DAY };
}

/** When the sweep locks a night in. `days` must be non-empty and sorted. */
export function lockTimeFor(days: NightDay[]): number {
  return days[0].startUtc - LOCK_LEAD_SECONDS;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/pickers.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` — expect exit 0.

```bash
git add src/domain/pickers.ts src/domain/pickers.test.ts
git commit -m "feat: picker option lists for days, start time and length

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: Max-players parsing and label

Additive only — the old `parsePlayerCounts` stays until Task 3, so the build stays green.

**Files:**
- Modify: `src/domain/playerCounts.ts`
- Test: `src/domain/playerCounts.test.ts`

**Interfaces:**
- Consumes: `PlayerCountError` (already in the file).
- Produces:
  - `parseMaxPlayers(text: string): number | null` — blank means `null` (any number); throws `PlayerCountError`
  - `playerCountLabel(maxPlayers: number | null): string` — `"any number of players"`, `"1 player"`, `"up to 4 players"`

- [ ] **Step 1: Write the failing tests**

Change the import at the top of `src/domain/playerCounts.test.ts` to:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_PLAYERS,
  PlayerCountError,
  parseMaxPlayers,
  parsePlayerCounts,
  playerCountLabel,
} from "./playerCounts.js";
```

Append to the end of the same file:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/playerCounts.test.ts`
Expected: FAIL — `parseMaxPlayers is not a function` (or a missing-export error).

- [ ] **Step 3: Implement**

Append to the end of `src/domain/playerCounts.ts`:

```ts
/**
 * Read the only player count a game still has: its maximum. Blank means any
 * number — the host should never be blocked on a number they have no opinion
 * about.
 */
export function parseMaxPlayers(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  const max = Number(trimmed);
  if (!Number.isInteger(max) || max < 1) {
    throw new PlayerCountError(
      `"${trimmed}" has to be a whole number of players, or blank for any number.`,
    );
  }
  return max;
}

/** How a game's size reads everywhere a game is listed. */
export function playerCountLabel(maxPlayers: number | null): string {
  if (maxPlayers === null) return "any number of players";
  return maxPlayers === 1 ? "1 player" : `up to ${maxPlayers} players`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/playerCounts.test.ts`
Expected: PASS — the existing `parsePlayerCounts` tests plus the 7 new ones.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` — expect exit 0.

```bash
git add src/domain/playerCounts.ts src/domain/playerCounts.test.ts
git commit -m "feat: parse a max-only player count and label it consistently

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: Remove minimum player counts

`Game.minPlayers` is removed. Every game is playable with one person, so the engine has no near misses left to report, and the renderer's copy changes to match.

**Files:**
- Modify: `src/domain/scheduling.ts` (full replacement below)
- Modify: `src/domain/playerCounts.ts`
- Modify: `src/db/repos/games.ts`
- Modify: `src/interactions/games.ts`
- Modify: `src/interactions/respond.ts`
- Modify: `src/interactions/setup.ts`
- Modify: `src/interactions/gamenightCreate.ts` (one line; Task 4 rewrites the rest)
- Modify: `src/commands/games.ts`
- Modify: `src/discord/render.ts`
- Tests: `src/domain/scheduling.test.ts`, `src/domain/playerCounts.test.ts`, `src/db/repos/games.test.ts`, `src/discord/render.test.ts`, plus fixture-only edits in `src/db/repos/nights.test.ts`, `src/discord/events.test.ts`, `src/interactions/setup.test.ts`, `src/interactions/gamenightCreate.test.ts`

**Interfaces:**
- Consumes: `parseMaxPlayers`, `playerCountLabel`, `PlayerCountError` (Task 2); `MIN_SESSION_HOURS` (Task 1).
- Produces:
  - `interface Game { id: number; name: string; maxPlayers: number | null; link?: string | null }` — no `minPlayers`
  - `interface SchedulingResult { top: Suggestion[] }` — no `nearMisses`; `NearMiss` no longer exists
  - `addGame(db, guildId: string, name: string, maxPlayers: number | null, createdBy: string, link?: string | null): Game`

- [ ] **Step 1: Update test fixtures mechanically**

Every test fixture drops `minPlayers`, and every `addGame(db, …)` call drops its fourth argument (the old minimum). Both shapes are uniform, so run:

```bash
find src -name '*.test.ts' -exec sed -i -E \
  -e '/^[[:space:]]*minPlayers: [0-9]+,[[:space:]]*$/d' \
  -e 's/ minPlayers: [0-9]+,//g' \
  -e 's/addGame\(db, ("[^"]*"), ("[^"]*"), [0-9]+, /addGame(db, \1, \2, /g' \
  {} +
```

Then fix the one multi-line call the regex cannot see. In `src/db/repos/games.test.ts`, in the test `stores an optional link`, change:

```ts
    const game = addGame(
      db,
      "g1",
      "Deep Rock",
      2,
      4,
      "u1",
      "https://store.steampowered.com/app/548430",
    );
```

to:

```ts
    const game = addGame(
      db,
      "g1",
      "Deep Rock",
      4,
      "u1",
      "https://store.steampowered.com/app/548430",
    );
```

Confirm nothing was missed: `grep -rn "minPlayers" src --include=*.test.ts` must print nothing.

- [ ] **Step 2: Rewrite the tests that assert on minimums or near misses**

In `src/domain/scheduling.test.ts`:

- Delete the line `const deepRock: Game = …` (every remaining use of it is in a test deleted below).
- Replace both occurrences of `toEqual({ top: [], nearMisses: [] })` with `toEqual({ top: [] })`.
- Replace the whole test `it("returns nothing when one person is free and the game needs two", …)` with:

```ts
  it("suggests a night when a single person is free and wants a game", () => {
    // No per-game minimum: one interested person is enough to schedule.
    const d = day(0, 6);
    const result = rankNight(input(everyone(d, ["a"], [0, 1, 2], [2])));
    expect(result.top).toHaveLength(1);
    expect(result.top[0].roster).toEqual(["a"]);
  });
```

- Delete these four tests entirely:
  - `it("reports a roster below min_players as a near miss, never a suggestion", …)`
  - `it("ranks near misses by smallest shortfall first", …)`
  - `it("returns no near misses once anything is viable", …)`
  - `it("prefers the longer window for a near miss when shortfall and roster size tie", …)`

In `src/db/repos/games.test.ts`, replace the whole tests `it("rejects a maximum below the minimum", …)` and `it("rejects a minimum below one", …)` with:

```ts
  it("stores every game with a minimum of one", () => {
    // The column outlived the feature: it stays in the schema (a CHECK
    // constraint references it) but is always 1 and never read.
    const game = addGame(db, "g1", "Deep Rock", 4, "u1");
    const row = db.prepare("SELECT min_players FROM games WHERE id = ?").get(game.id) as {
      min_players: number;
    };
    expect(row.min_players).toBe(1);
  });

  it("rejects a maximum below one", () => {
    expect(() => addGame(db, "g1", "Bad", 0, "u1")).toThrow();
  });
```

In `src/domain/playerCounts.test.ts`:

- Delete the whole `describe("parsePlayerCounts", …)` block.
- Change the import to:

```ts
import { describe, expect, it } from "vitest";
import { PlayerCountError, parseMaxPlayers, playerCountLabel } from "./playerCounts.js";
```

In `src/discord/render.test.ts`:

- Delete the test `it("dates a near miss so it names the evening it is talking about", …)`.
- Delete the test `it("explains the near misses when nothing was viable", …)`.
- Delete the whole block `describe("near-miss tense", …)`.
- Add these two tests inside `describe("renderPoll", …)`, right after the test `it("plainly says nobody answered when a night fails with zero responses", …)`:

```ts
  it("explains a failed night that did get answers", () => {
    const availability = new Map([["a", new Set<number>()]]);
    const text = JSON.stringify(renderPoll(failedView({ availability })).embeds[0].toJSON());
    expect(text).toMatch(/nobody who answered was free for 2 hours in a row/i);
    expect(text).not.toMatch(/closest misses/i);
  });

  it("does not claim there are no responses on an open poll that has some", () => {
    const availability = new Map([["a", new Set<number>()]]);
    const text = JSON.stringify(renderPoll(openView({ availability })).embeds[0].toJSON());
    expect(text).toMatch(/nobody is free for 2 hours in a row with a game picked/i);
    expect(text).not.toMatch(/no responses yet/i);
  });
```

- [ ] **Step 3: Run the tests to see what fails**

Run: `npx vitest run`
Expected: FAIL — the two new render tests, the rewritten scheduling and games tests, and anything that still passes `minPlayers` (production code has not changed yet). `npm run typecheck` also fails on `minPlayers` and `nearMisses`. That is the target for the next step.

- [ ] **Step 4: Replace the scheduling engine**

Replace the entire contents of `src/domain/scheduling.ts` with:

```ts
import { SLOT_SECONDS, slotsIn, type NightDay } from "./timeblocks.js";

export interface Game {
  id: number;
  name: string;
  /** The most people the game supports; null means any number. */
  maxPlayers: number | null;
  /**
   * Purely a display field — never read by ranking. Optional so the many
   * `Game` fixtures in tests unrelated to links don't need to carry it;
   * a game loaded from the repository always sets it explicitly.
   */
  link?: string | null;
}

export interface SchedulingInput {
  days: NightDay[];
  minSessionHours: number;
  games: Game[];
  /** userId -> the UTC hours (epoch seconds) they are free. */
  availability: Map<string, Set<number>>;
  /** userId -> the game ids they would play. */
  votes: Map<string, Set<number>>;
}

export interface Suggestion {
  dayIndex: number;
  startUtc: number;
  endUtc: number;
  game: Game;
  roster: string[];
  oversubscribed: boolean;
}

export interface SchedulingResult {
  /**
   * The best suggestions, day-diversified: distinct-day picks are preferred
   * over same-day backfills, so array order is not strictly rank order —
   * a backfilled entry can outrank an earlier distinct-day pick.
   */
  top: Suggestion[];
}

export const MAX_SUGGESTIONS = 3;

/** Runs are measured in half-hour slots; minSessionHours converts into them. */
const SLOTS_PER_HOUR = 3600 / SLOT_SECONDS;

/** Users free for every hour of the run. Partial attendance does not count. */
function freeForAll(
  run: number[],
  availability: Map<string, Set<number>>,
): string[] {
  const users: string[] = [];
  for (const [userId, hours] of availability) {
    if (run.every((hour) => hours.has(hour))) users.push(userId);
  }
  return users;
}

function totalVotes(gameId: number, votes: Map<string, Set<number>>): number {
  let count = 0;
  for (const chosen of votes.values()) if (chosen.has(gameId)) count += 1;
  return count;
}

function compareSuggestions(
  a: Suggestion,
  b: Suggestion,
  voteCounts: Map<number, number>,
): number {
  if (a.roster.length !== b.roster.length) return b.roster.length - a.roster.length;
  const aLength = a.endUtc - a.startUtc;
  const bLength = b.endUtc - b.startUtc;
  if (aLength !== bLength) return bLength - aLength;
  if (a.startUtc !== b.startUtc) return a.startUtc - b.startUtc;
  return (voteCounts.get(b.game.id) ?? 0) - (voteCounts.get(a.game.id) ?? 0);
}

export function rankNight(input: SchedulingInput): SchedulingResult {
  const { days, minSessionHours, games, availability, votes } = input;

  if (minSessionHours < 1) return { top: [] };
  // Availability is stored per half-hour slot, so a 2-hour minimum is a run
  // of 4. The stored value stays in hours: that is the unit a host thinks in,
  // and the conversion belongs here rather than in the database.
  const minSessionSlots = minSessionHours * SLOTS_PER_HOUR;

  const voteCounts = new Map(games.map((g) => [g.id, totalVotes(g.id, votes)]));
  const voters = new Map(
    games.map((g) => [
      g.id,
      new Set(
        [...votes.entries()].filter(([, ids]) => ids.has(g.id)).map(([userId]) => userId),
      ),
    ]),
  );

  const suggestions: Suggestion[] = [];

  for (const day of days) {
    const slots = slotsIn(day);
    for (let start = 0; start < slots.length; start += 1) {
      for (let end = start + minSessionSlots; end <= slots.length; end += 1) {
        const run = slots.slice(start, end);
        const free = freeForAll(run, availability);
        if (free.length === 0) continue;

        const startUtc = run[0];
        const endUtc = run[run.length - 1] + SLOT_SECONDS;

        for (const game of games) {
          const eligible = voters.get(game.id)!;
          const roster = free.filter((userId) => eligible.has(userId));
          // No per-game minimum: one interested person is enough to put a
          // night on the calendar, and whoever set it up is usually happy
          // to play regardless.
          if (roster.length === 0) continue;

          suggestions.push({
            dayIndex: day.dayIndex,
            startUtc,
            endUtc,
            game,
            roster: roster.sort(),
            oversubscribed: game.maxPlayers !== null && roster.length > game.maxPlayers,
          });
        }
      }
    }
  }

  suggestions.sort((a, b) => compareSuggestions(a, b, voteCounts));

  // One entry per (day, game): the sort above already put the best one first.
  const bestPerDayGame: Suggestion[] = [];
  const seen = new Set<string>();
  for (const suggestion of suggestions) {
    const key = `${suggestion.dayIndex}:${suggestion.game.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bestPerDayGame.push(suggestion);
  }

  // Prefer distinct days, then backfill in rank order if we came up short.
  const top: Suggestion[] = [];
  const usedDays = new Set<number>();
  const skipped: Suggestion[] = [];
  for (const suggestion of bestPerDayGame) {
    if (top.length === MAX_SUGGESTIONS) break;
    if (usedDays.has(suggestion.dayIndex)) {
      skipped.push(suggestion);
      continue;
    }
    usedDays.add(suggestion.dayIndex);
    top.push(suggestion);
  }
  for (const suggestion of skipped) {
    if (top.length === MAX_SUGGESTIONS) break;
    top.push(suggestion);
  }

  return { top };
}
```

- [ ] **Step 5: Remove the old minimum parser**

In `src/domain/playerCounts.ts`, delete `DEFAULT_MIN_PLAYERS` (with its doc comment) and `parsePlayerCounts` (with its doc comment). What remains is `PlayerCountError`, `parseMaxPlayers` and `playerCountLabel`.

- [ ] **Step 6: Update the games repository**

In `src/db/repos/games.ts`, replace the `GameRow` interface, `toGame`, `SELECT` and `addGame` with:

```ts
interface GameRow {
  id: number;
  name: string;
  max_players: number | null;
  link: string | null;
}

const toGame = (row: GameRow): Game => ({
  id: row.id,
  name: row.name,
  maxPlayers: row.max_players,
  link: row.link,
});

const SELECT = "SELECT id, name, max_players, link FROM games";

/**
 * `min_players` is written as a literal 1: the column outlived the feature,
 * and SQLite cannot drop a column referenced by a CHECK constraint without
 * rebuilding the table. Nothing reads it.
 */
export function addGame(
  db: DatabaseSync,
  guildId: string,
  name: string,
  maxPlayers: number | null,
  createdBy: string,
  link: string | null = null,
): Game {
  const trimmed = name.trim();
  const result = db
    .prepare(
      `INSERT INTO games (guild_id, name, min_players, max_players, created_by, link)
       VALUES (?, ?, 1, ?, ?, ?)`,
    )
    .run(guildId, trimmed, maxPlayers, createdBy, link);
  return {
    id: Number(result.lastInsertRowid),
    name: trimmed,
    maxPlayers,
    link,
  };
}
```

- [ ] **Step 7: Update the `/games add` form**

In `src/interactions/games.ts`:

Change the `playerCounts` import to:

```ts
import { PlayerCountError, parseMaxPlayers, playerCountLabel } from "../domain/playerCounts.js";
```

In `buildGameAddModal`, delete the action row whose text input has `setCustomId("min")` (label "Fewest players (optional)"). The modal keeps the name, max and link rows.

In `handleGameAddModal`, replace the block from `let min: number;` through the end of its `try`/`catch` with:

```ts
  let max: number | null;
  try {
    max = parseMaxPlayers(interaction.fields.getTextInputValue("max"));
  } catch (error) {
    if (error instanceof PlayerCountError) {
      await interaction.reply({ content: error.message, flags: MessageFlags.Ephemeral });
      return;
    }
    throw error;
  }
```

Replace the `addGame` call and the confirmation `content` with:

```ts
  const game = addGame(ctx.db, guildId, name, max, interaction.user.id, link);
```

```ts
    content: `Added **${game.name}** (${playerCountLabel(game.maxPlayers)}).${link ? `\n${link}` : ""}`,
```

- [ ] **Step 8: Update the Suggest-a-game form and vote labels**

In `src/interactions/respond.ts`:

Change the `playerCounts` import to:

```ts
import { PlayerCountError, parseMaxPlayers, playerCountLabel } from "../domain/playerCounts.js";
```

In `handleSuggestButton`, delete the action row whose text input has `setCustomId("min")`.

In `handleSuggestModal`, replace the block from `let min: number;` through the end of its `try`/`catch` with the same code as Step 7's `let max` block. Then change the `addGame` fallback to:

```ts
  const game =
    existing ?? addGame(ctx.db, night.guildId, name, max, interaction.user.id, link);
```

and the confirmation to:

```ts
  const confirmation = `Added **${game.name}** (${playerCountLabel(game.maxPlayers)}) and voted you for it.`;
```

In `handleVotesButton`, change the option `description` to:

```ts
              description: playerCountLabel(g.maxPlayers),
```

- [ ] **Step 9: Update the remaining game labels**

In `src/interactions/setup.ts`, add `import { playerCountLabel } from "../domain/playerCounts.js";` and change the games-select option `description` to `description: playerCountLabel(g.maxPlayers),`.

In `src/interactions/gamenightCreate.ts`, add `import { playerCountLabel } from "../domain/playerCounts.js";` and change the games-select option `description` to `description: playerCountLabel(g.maxPlayers),`.

In `src/commands/games.ts`, add `import { playerCountLabel } from "../domain/playerCounts.js";` and change the `/games list` line to:

```ts
      const base = `• **${g.name}** — ${playerCountLabel(g.maxPlayers)}`;
```

- [ ] **Step 10: Update the renderer**

In `src/discord/render.ts`, add:

```ts
import { MIN_SESSION_HOURS } from "../domain/pickers.js";
```

Replace `suggestionLines` with:

```ts
function suggestionLines(view: PollView): string {
  if (view.result.top.length === 0) {
    // Near misses used to fill this space whenever anyone had answered, so
    // the "no responses" wording only ever showed on an empty poll. Without
    // them, it has to check — a poll with answers must not claim it has none.
    return view.responderIds.size === 0
      ? "_Nothing yet — no responses yet._"
      : `_Nothing yet — nobody is free for ${MIN_SESSION_HOURS} hours in a row with a game picked._`;
  }
  return view.result.top
    .map((s, index) => {
      const flag = s.oversubscribed
        ? ` — ${s.roster.length} in, plays ${s.game.maxPlayers}, split lobbies?`
        : "";
      return [
        `**${index + 1}. ${dayAndClock(s.startUtc)}–${clock(s.endUtc)} · ${s.game.name}** · ${s.roster.length} players${flag}`,
        mentionList(s.roster, SUGGESTION_MENTION_CAP),
      ].join("\n");
    })
    .join("\n\n");
}
```

In `renderPoll`'s failed branch, replace:

```ts
    } else {
      embed.setDescription("**No viable night.** Closest misses:");
      embed.addFields({ name: "Near misses", value: fitField(suggestionLines(view)) });
    }
```

with:

```ts
    } else {
      // With no per-game minimum, one person is enough — so the only way to
      // fail with answers in hand is that nobody had both a full session
      // free and a game picked.
      embed.setDescription(
        `**No viable night.** Nobody who answered was free for ${MIN_SESSION_HOURS} hours in a row and also picked a game.`,
      );
    }
```

- [ ] **Step 11: Verify**

Run: `npm run typecheck` — expect exit 0.
Run: `npx vitest run` — expect every test to pass.
Run: `grep -rn "minPlayers\|nearMiss\|NearMiss\|shortfall\|parsePlayerCounts\|DEFAULT_MIN_PLAYERS" src` — expect no output.

If any test *other than* the ones edited in Step 2 fails, stop and report it rather than editing the test: it means ranking behaviour changed somewhere the plan did not anticipate.

- [ ] **Step 12: Commit**

```bash
git add -A src
git commit -m "feat: drop minimum player counts and the near misses they produced

Every game is now playable with one person. Near-miss ranking and its
rendering go with it; a failed or empty poll explains itself instead.
games.min_players stays in the schema and is always written as 1.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: Picker-based create form

**Files:**
- Modify: `src/interactions/gamenightCreate.ts` (full replacement below)
- Modify: `src/commands/gamenight.ts`
- Modify: `src/discord/render.ts` (one line)
- Modify: `src/domain/timeblocks.ts` (full replacement below)
- Test: `src/interactions/gamenightCreate.test.ts` (full replacement below), `src/domain/timeblocks.test.ts`, `src/discord/render.test.ts`

**Interfaces:**
- Consumes: from Task 1 `dayOptions`, `START_TIME_OPTIONS`, `LENGTH_OPTIONS`, `MIN_SESSION_HOURS`, `SELECT_OPTION_LIMIT`, `windowFromStartAndLength`, `lockTimeFor`; from Task 2 `playerCountLabel`; existing `MAX_DAYS`, `expandDays`, `createDraftNight`, `setNightGames`, `listGames`, `requireTimezone`, `log`, `buildGameSetupComponents`, `librarySelectNote`.
- Produces: `buildGameNightCreateModal(library: Game[], tz: string, now: DateTime): ModalBuilder` — modal field custom ids, in order: `title`, `games`, `days`, `start`, `length`.

- [ ] **Step 1: Write the failing modal tests**

Replace the entire contents of `src/interactions/gamenightCreate.test.ts` with:

```ts
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { buildGameNightCreateModal } from "./gamenightCreate.js";
import type { Game } from "../domain/scheduling.js";

const CHI = "America/Chicago";
// Saturday afternoon.
const NOW = DateTime.fromISO("2026-09-26T15:00:00", { zone: CHI });

const library: Game[] = [
  { id: 1, name: "Catan", maxPlayers: 4 },
  { id: 2, name: "Deep Rock", maxPlayers: null },
];

interface FieldJson {
  custom_id?: string;
  min_values?: number;
  max_values?: number;
  options?: { value: string; label: string; description?: string }[];
}

/** Each field's inner component, in the order the host sees them. */
function fields(lib: Game[] = library): FieldJson[] {
  const json = buildGameNightCreateModal(lib, CHI, NOW).toJSON() as {
    components: { component?: FieldJson }[];
  };
  return json.components.map((c) => c.component ?? {});
}

const field = (id: string) => fields().find((f) => f.custom_id === id);

describe("buildGameNightCreateModal", () => {
  it("asks for title, games, days, start time and length, in that order", () => {
    expect(fields().map((f) => f.custom_id)).toEqual(["title", "games", "days", "start", "length"]);
  });

  it("has no free-text date, time or deadline field left", () => {
    const ids = fields().map((f) => f.custom_id);
    expect(ids).not.toContain("day");
    expect(ids).not.toContain("hours");
    expect(ids).not.toContain("deadline");
  });

  it("labels games by their maximum player count", () => {
    expect(field("games")?.options?.map((o) => [o.value, o.description])).toEqual([
      ["1", "up to 4 players"],
      ["2", "any number of players"],
    ]);
  });

  it("offers 25 days starting today, and lets the host pick up to five", () => {
    const days = field("days");
    expect(days?.options).toHaveLength(25);
    expect(days?.options?.[0]).toMatchObject({
      value: "2026-09-26",
      label: "Sat Sep 26",
      description: "Today",
    });
    expect(days?.min_values).toBe(1);
    expect(days?.max_values).toBe(5);
  });

  it("offers start times from noon to 11:30pm", () => {
    const start = field("start");
    expect(start?.options).toHaveLength(24);
    expect(start?.options?.[0]).toMatchObject({ value: "720", label: "12pm" });
    expect(start?.options?.at(-1)).toMatchObject({ value: "1410", label: "11:30pm" });
  });

  it("offers lengths from 2 to 12 hours", () => {
    const length = field("length");
    expect(length?.options).toHaveLength(21);
    expect(length?.options?.[0]).toMatchObject({ value: "120", label: "2 hours" });
    expect(length?.options?.at(-1)).toMatchObject({ value: "720", label: "12 hours" });
  });

  it("stays within Discord's 25-option select limit for games", () => {
    const big: Game[] = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      name: `Game ${i + 1}`,
      maxPlayers: null,
    }));
    expect(fields(big).find((f) => f.custom_id === "games")?.options).toHaveLength(25);
  });
});
```

In `src/discord/render.test.ts`, add this test inside `describe("renderPoll", …)`:

```ts
  it("says when the bot will pick the night", () => {
    const text = JSON.stringify(renderPoll(openView()).embeds[0].toJSON());
    expect(text).toContain("Picks the night <t:1800000000:R>");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/interactions/gamenightCreate.test.ts src/discord/render.test.ts`
Expected: FAIL — the modal still has `day`/`hours`/`deadline` text fields, and the poll still says `Deadline`.

- [ ] **Step 3: Rewrite the create modal and handler**

Replace the entire contents of `src/interactions/gamenightCreate.ts` with:

```ts
import {
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from "discord.js";
import { DateTime } from "luxon";
import type { AppContext } from "../context.js";
import type { Game } from "../domain/scheduling.js";
import { listGames } from "../db/repos/games.js";
import { createDraftNight, setNightGames } from "../db/repos/nights.js";
import { MAX_DAYS, expandDays } from "../domain/timeblocks.js";
import {
  LENGTH_OPTIONS,
  MIN_SESSION_HOURS,
  SELECT_OPTION_LIMIT,
  START_TIME_OPTIONS,
  dayOptions,
  lockTimeFor,
  windowFromStartAndLength,
  type PickerOption,
} from "../domain/pickers.js";
import { playerCountLabel } from "../domain/playerCounts.js";
import { requireTimezone } from "../discord/timezonePicker.js";
import { log } from "../log.js";
import { buildGameSetupComponents, librarySelectNote } from "./setup.js";

/** A picker option as a select-menu option; values travel as strings. */
function selectOption(option: PickerOption<string | number>) {
  return {
    label: option.label,
    value: String(option.value),
    ...(option.description ? { description: option.description } : {}),
  };
}

/**
 * The whole poll in one screen: title, games, days, start time, length.
 *
 * Built from `LabelBuilder` rather than `ActionRowBuilder` because a modal
 * action row only accepts a text input — a select menu has to be wrapped in a
 * label, which is also the API discord.js now wants.
 *
 * Everything but the title is a dropdown. Discord has no date or time picker,
 * so dropdowns are the closest thing — and they make a malformed date or time
 * impossible to submit, rather than something to parse and reject. Five
 * components is Discord's modal maximum, so this is full: the voice channel
 * picker stays on the setup screen, and there is no deadline field — the bot
 * locks the night an hour before the first chosen day starts.
 */
export function buildGameNightCreateModal(
  library: Game[],
  tz: string,
  now: DateTime,
): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("gn:createmodal")
    .setTitle("Start a game night")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Title for the post (optional)")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("title")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(80)
            .setRequired(false),
        ),
      new LabelBuilder()
        .setLabel("Games")
        .setDescription("Everything you would be happy to play that night.")
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId("games")
            .setPlaceholder("Pick at least one")
            .setMinValues(1)
            .setMaxValues(Math.min(library.length, SELECT_OPTION_LIMIT))
            .addOptions(
              library.slice(0, SELECT_OPTION_LIMIT).map((g) => ({
                label: g.name.slice(0, 100),
                description: playerCountLabel(g.maxPlayers),
                value: String(g.id),
              })),
            ),
        ),
      new LabelBuilder()
        .setLabel("Days")
        .setDescription(`Up to ${MAX_DAYS}. Friends mark which of these they're free.`)
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId("days")
            .setPlaceholder("Pick the days you could play")
            .setMinValues(1)
            .setMaxValues(MAX_DAYS)
            .addOptions(dayOptions(tz, now).map(selectOption)),
        ),
      new LabelBuilder()
        .setLabel("Start time")
        .setDescription(`Each day, in ${tz}.`)
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId("start")
            .setPlaceholder("When it could start")
            .addOptions(START_TIME_OPTIONS.map(selectOption)),
        ),
      new LabelBuilder()
        .setLabel("Length")
        .setDescription("How long you could play, each day.")
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId("length")
            .setPlaceholder("How long")
            .addOptions(LENGTH_OPTIONS.map(selectOption)),
        ),
    );
}

export async function handleGameNightCreateModal(
  interaction: ModalSubmitInteraction,
  ctx: AppContext,
): Promise<void> {
  // The command that showed this modal already checked guild/channel, but
  // that was a different interaction — TypeScript has no way to know these
  // are still non-null on this one, so the guard is real, not decorative.
  if (!interaction.guildId || !interaction.channelId) {
    await interaction.reply({
      content: "Game nights only work inside a server channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;

  const tz = await requireTimezone(interaction, ctx);
  if (!tz) {
    log.info("Create form paused: host has no timezone yet, showed the picker", {
      user: interaction.user.id,
    });
    return;
  }

  const now = DateTime.now().setZone(tz);
  const titleText = interaction.fields.getTextInputValue("title").trim();
  const pickedGameIds = interaction.fields.getStringSelectValues("games").map(Number);
  // Sorted because the first day decides the lock time, and a select returns
  // values in the order they were clicked.
  const pickedDays = [...interaction.fields.getStringSelectValues("days")].sort();
  const startMinutes = Number(interaction.fields.getStringSelectValues("start")[0]);
  const lengthMinutes = Number(interaction.fields.getStringSelectValues("length")[0]);

  const submitted = {
    title: titleText,
    gameIds: pickedGameIds,
    days: pickedDays,
    startMinutes,
    lengthMinutes,
    timezone: tz,
  };
  log.info("Create form submitted", submitted);

  const expanded = expandDays(
    pickedDays,
    windowFromStartAndLength(startMinutes, lengthMinutes),
    tz,
  );
  const lockUtc = lockTimeFor(expanded);

  // The only input a picker cannot rule out: time passing. A first day
  // starting within the hour leaves nobody time to answer — and a modal left
  // open past midnight offers a "today" that has become yesterday.
  if (lockUtc <= now.toUnixInteger()) {
    const reason =
      "Your first day starts in less than an hour — pick a later start time or day, so people have time to answer.";
    log.warn("Create form rejected", { reason, ...submitted });
    await interaction.reply({ content: reason, flags: MessageFlags.Ephemeral });
    return;
  }

  const nightId = createDraftNight(ctx.db, {
    guildId,
    channelId,
    hostId: interaction.user.id,
    title: titleText || "Game Night",
    displayTz: tz,
    minSessionHours: MIN_SESSION_HOURS,
    deadlineUtc: lockUtc,
    voiceChannelId: null,
    days: expanded,
    createdUtc: now.toUnixInteger(),
  });

  // The modal's picks seed the night, so the setup screen opens with them
  // already selected — it is there to adjust, attach a voice channel, and
  // post, not to ask the same question a second time.
  setNightGames(ctx.db, nightId, pickedGameIds);
  log.info("Draft night created", { nightId, days: expanded.length, lockUtc });

  const library = listGames(ctx.db, guildId);
  await interaction.reply({
    content: `Attach a voice channel if you want one, then post it.${librarySelectNote(library.length)}`,
    flags: MessageFlags.Ephemeral,
    components: buildGameSetupComponents(nightId, library, pickedGameIds, null),
  });
}
```

- [ ] **Step 4: Pass the timezone to the modal**

In `src/commands/gamenight.ts`, add `import { DateTime } from "luxon";` and change:

```ts
  await interaction.showModal(buildGameNightCreateModal(library));
```

to:

```ts
  await interaction.showModal(buildGameNightCreateModal(library, tz, DateTime.now()));
```

- [ ] **Step 5: Reword the poll's deadline line**

In `src/discord/render.ts`, change:

```ts
    .setDescription(`Deadline <t:${view.deadlineUtc}:R>`)
```

to:

```ts
    .setDescription(`Picks the night <t:${view.deadlineUtc}:R>`)
```

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `npx vitest run src/interactions/gamenightCreate.test.ts src/discord/render.test.ts`
Expected: PASS.

- [ ] **Step 7: Remove the free-text parsers**

Replace the entire contents of `src/domain/timeblocks.ts` with:

```ts
import { DateTime } from "luxon";

/**
 * An evening window, as minutes from local midnight. Minutes rather than
 * hours because availability moves in half hours; `endMinutes` at or before
 * `startMinutes` means the window crosses into the next day.
 */
export interface DayWindow {
  startMinutes: number;
  endMinutes: number;
}

/** How long one availability slot is. Everything downstream derives from this. */
export const SLOT_SECONDS = 1800;

export interface NightDay {
  dayIndex: number;
  startUtc: number;
  endUtc: number;
}

/**
 * Most days one night may offer. Each day becomes its own availability
 * dropdown, and Discord allows only five in one message.
 */
export const MAX_DAYS = 5;
/**
 * Longest evening window a night may cover. Not an arbitrary tidiness rule:
 * every slot becomes an option in that day's availability dropdown, and a
 * Discord select menu holds 25 options. At half-hour granularity that is 24
 * slots for a 12-hour window — the longest that can still be answered. It
 * also keeps the availability grid inside the 1024-character limit on an
 * embed field, which discord.js enforces by throwing, so an oversized poll
 * would never post at all.
 */
export const MAX_WINDOW_HOURS = 12;

export function expandDays(
  isoDates: string[],
  window: DayWindow,
  tz: string,
): NightDay[] {
  const at = (base: DateTime, minutes: number) =>
    base.set({ hour: Math.floor(minutes / 60), minute: minutes % 60 });

  return isoDates.map((iso, dayIndex) => {
    const base = DateTime.fromISO(iso, { zone: tz }).startOf("day");
    const start = at(base, window.startMinutes);
    const crossesMidnight = window.endMinutes <= window.startMinutes;
    const end = at(crossesMidnight ? base.plus({ days: 1 }) : base, window.endMinutes);
    return { dayIndex, startUtc: start.toUnixInteger(), endUtc: end.toUnixInteger() };
  });
}

/** Every half-hour slot the day offers, as epoch seconds at the slot start. */
export function slotsIn(day: NightDay): number[] {
  const slots: number[] = [];
  for (let t = day.startUtc; t < day.endUtc; t += SLOT_SECONDS) slots.push(t);
  return slots;
}

/** `6p`, or `6:30p` for a slot that does not land on the hour. */
export function formatSlotLabel(utcSlot: number, tz: string): string {
  const local = DateTime.fromSeconds(utcSlot, { zone: tz });
  const hour12 = local.hour % 12 === 0 ? 12 : local.hour % 12;
  const meridiem = local.hour < 12 ? "a" : "p";
  return local.minute === 0
    ? `${hour12}${meridiem}`
    : `${hour12}:${String(local.minute).padStart(2, "0")}${meridiem}`;
}

/** True when a slot begins exactly on the hour. Used to thin out grid labels. */
export function isOnTheHour(utcSlot: number, tz: string): boolean {
  return DateTime.fromSeconds(utcSlot, { zone: tz }).minute === 0;
}

export function formatDayLabel(day: NightDay, tz: string): string {
  return DateTime.fromSeconds(day.startUtc, { zone: tz }).toFormat("ccc LLL d");
}

/**
 * Slot labels for a set of instants, guaranteed distinct.
 *
 * On a DST fall-back night the clock repeats an hour, so two different
 * instants format identically — "1a" and "1a". `slotsIn` correctly yields
 * both, because both are real playable slots, but a dropdown offering two
 * identical options is unusable: whichever the player picks, they have a 50%
 * chance of claiming an hour they did not mean. Marking the repeat keeps the
 * options tellable apart, in the order they actually happen.
 */
export function slotLabels(slots: number[], tz: string): string[] {
  const seen = new Map<string, number>();
  return slots.map((slot) => {
    const label = formatSlotLabel(slot, tz);
    const previous = seen.get(label) ?? 0;
    seen.set(label, previous + 1);
    return previous === 0 ? label : `${label} (again)`;
  });
}
```

- [ ] **Step 8: Remove the parser tests**

In `src/domain/timeblocks.test.ts`:

- Change the import block to:

```ts
import {
  MAX_WINDOW_HOURS,
  expandDays,
  formatDayLabel,
  formatSlotLabel,
  slotLabels,
  slotsIn,
} from "./timeblocks.js";
```

- Delete these `describe` blocks entirely: `"parseWindow"`, `"parseDays"`, `"parseDeadline"`, `"windowSlots"`, `"assertSessionFitsWindow"`, `"parseDeadline minute precision"`, `"relative deadlines in minutes"`.
- Inside `describe("half-hour granularity", …)`, delete these tests: `"parses a window starting on the half hour"`, `"parses a window ending on the half hour"`, `"still rejects minutes that are not a half hour"`, `"counts a window in half-hour slots"`, `"counts a slot window that crosses midnight"`.
- In the test `"caps the window so a day's slots still fit one Discord select"`, delete the line `expect(() => parseWindow("6am-11pm")).toThrow(/at most 12 hours/i);` and keep the `MAX_WINDOW_HOURS * 2` assertion.
- If `NOW` is no longer referenced anywhere in the file, delete its declaration and the `// A Tuesday.` comment above it. If `DateTime` is then unused, remove `import { DateTime } from "luxon";` too — but it is still used by the half-hour tests, so check before removing.

- [ ] **Step 9: Verify**

Run: `npm run typecheck` — expect exit 0.
Run: `npx vitest run` — expect every test to pass.
Run: `npm run build` — expect exit 0.
Run: `grep -rn "parseDays\|parseWindow\|parseDeadline\|TimeParseError\|assertSessionFitsWindow\|windowSlots" src` — expect no output.

- [ ] **Step 10: Commit**

```bash
git add -A src
git commit -m "feat: pick days and times from dropdowns, and lock an hour ahead

The create form's days, start time and length are now dropdowns, so a
malformed date or time can no longer be submitted. The deadline field is
gone: the bot locks the night an hour before the first chosen day
starts. The free-text parsers, and the date-plus-12-hour deadline bug in
one of them, are removed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 11: Live check in Discord (human)**

Restart the bot (`npm run dev`); no `npm run deploy` is needed. Then:
1. `/gamenight create` → the form shows Title, Games, Days, Start time, Length, all but Title as dropdowns, with today first in Days.
2. Pick today with a start time less than an hour away → rejected with the "less than an hour" message, and `Create form rejected` in the console.
3. Pick tomorrow, 7:30pm, 3½ hours → setup screen appears; **Post it** → the poll says "Picks the night in …" about an hour before 7:30pm tomorrow.
4. `/games add` → the form has no "Fewest players" field; leave Most players blank → "Added X (any number of players)."

---

## Task 5: README

**Files:**
- Modify: `README.md`

The README still documents `days:` and `window:` as slash-command options, which predate even the current modal. Bring it in line with the picker form.

- [ ] **Step 1: Replace the introduction**

Replace the paragraph starting `A Discord bot for scheduling game nights.` (through `creates a Discord Scheduled Event for it.`) with:

```markdown
A Discord bot for scheduling game nights. A host picks some upcoming days,
a start time and a length, and a shortlist of games from the server's
library. Players answer with the hours they're actually free and which of
those games they'd play. An hour before the first day, the bot doesn't ask
anyone to decide — it works out the best (time window × game) combination
itself, posts the result, and creates a Discord Scheduled Event for it.
```

- [ ] **Step 2: Replace the "What it does" bullets about creating and locking**

Replace the bullet starting `` - `/gamenight create` opens a short private setup flow `` with:

```markdown
- `/gamenight create` opens a form where every date and time is picked from
  a dropdown, with no typing: up to five days from the next 25, a start
  time, and how long you could play. A private setup screen follows for
  adjusting games and attaching a voice channel, then **Post it** puts the
  poll in the channel.
```

Replace the bullet starting `- At the deadline, the bot picks the best combination` with:

```markdown
- An hour before the first day starts, the bot picks the best combination
  on its own — the (time window × game) pairing with the largest roster —
  locks the night, creates a Discord Scheduled Event, and pings the roster.
  If nobody who answered was free for two hours in a row with a game
  picked, the night is marked failed instead.
```

- [ ] **Step 3: Replace the `/gamenight create` reference**

Replace everything from the line `` ### `/gamenight create` `` up to (not including) `` ### `/gamenight cancel` `` with:

```markdown
### `/gamenight create`

No options. Opens a form for a new game night in the channel it's run in.
Only one open night is allowed per channel at a time.

| Field      | Required | How you fill it                                                        |
| ---------- | -------- | ---------------------------------------------------------------------- |
| Title      | no       | Text, up to 80 characters. Defaults to "Game Night".                   |
| Games      | yes      | Pick from the server's library (the first 25 alphabetically).          |
| Days       | yes      | Pick up to 5 of the next 25 days.                                      |
| Start time | yes      | Noon to 11:30pm, in half hours, in your timezone.                      |
| Length     | yes      | 2 to 12 hours, in half hours. A night that runs past midnight just works. |

There's no deadline to set: the bot locks the night one hour before the
first day you picked starts, so that day has to start more than an hour
from now.

After you submit, a private setup screen lets you adjust the games, add one
that isn't in the library yet (**Add a game**), attach a voice channel for
the Scheduled Event, and **Post it**. The poll only becomes visible to the
channel once you click **Post it**.

```

- [ ] **Step 4: Replace the `/games add` reference**

Replace everything from the line `` ### `/games add` `` up to (not including) `` ### `/games list` `` with:

```markdown
### `/games add`

Adds a game to the server's shared library. Start typing in the optional
`name` option to search Steam, or skip it. Either way, a form opens:

| Field        | Required | Description                                                     |
| ------------ | -------- | --------------------------------------------------------------- |
| Game name    | yes      | Up to 80 characters. Pre-filled if you picked a Steam title.    |
| Most players | no       | The most people it supports. Leave blank for any number.        |
| Link         | no       | A store page or website, starting with `http://` or `https://`. |

The confirmation is only visible to you.

```

- [ ] **Step 5: Replace walkthrough steps 1, 2 and 5**

In `## How a game night actually works, end to end`, replace steps 1 and 2 with:

```markdown
1. A host runs `/gamenight create` and picks a title, games, up to five
   days, a start time and a length — all from dropdowns. A private setup
   screen follows.
2. The host adjusts the games if needed (or adds a new one on the spot),
   optionally attaches a voice channel, then clicks **Post it**. The poll
   goes live in the channel as a single message.
```

and replace step 5 with:

```markdown
5. An hour before the first day starts, a background sweep (checked every
   30 seconds) picks the best combination itself — the one with the
   largest roster — creates a Discord Scheduled Event for it, posts the
   result, and pings the roster. If nobody who answered was free for two
   hours in a row with a game picked, the night is marked failed instead.
```

- [ ] **Step 6: Check nothing stale remains**

Run: `grep -n -i "deadline:\|window:\|minhours\|min:4\|near-miss\|near miss\|minimum player" README.md`
Expected: no output. (`/gamenight cancel` and the deployment sections do not mention deadlines and need no change.)

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: describe the picker-based create form and games without a minimum

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
