import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  LENGTH_OPTIONS,
  LOCK_LEAD_SECONDS,
  MIN_SESSION_HOURS,
  SELECT_OPTION_LIMIT,
  START_TIME_OPTIONS,
  dayOptions,
  expandPickedDays,
  lockIsStillAhead,
  lockTimeFor,
  windowFromStartAndLength,
} from "./pickers.js";
import { MAX_WINDOW_HOURS, expandDays, slotsIn } from "./timeblocks.js";

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

describe("expandPickedDays", () => {
  it("matches expandDays on an ordinary day", () => {
    const isoDates = ["2026-09-28"];
    const startMinutes = 19 * 60;
    const lengthMinutes = 3 * 60;
    expect(expandPickedDays(isoDates, startMinutes, lengthMinutes, CHI)).toEqual(
      expandDays(isoDates, windowFromStartAndLength(startMinutes, lengthMinutes), CHI),
    );
  });

  it("gives exactly 24 slots and a 12-hour span across a Chicago fall-back", () => {
    const [day] = expandPickedDays(["2026-10-31"], 18 * 60, 12 * 60, CHI);
    expect(slotsIn(day)).toHaveLength(24);
    expect(day.endUtc - day.startUtc).toBe(12 * 3600);
  });

  it("gives exactly 24 slots across a London fall-back", () => {
    const [day] = expandPickedDays(["2026-10-24"], 14 * 60, 12 * 60, "Europe/London");
    expect(slotsIn(day)).toHaveLength(24);
  });

  it("gives exactly 24 slots across a Chicago spring-forward", () => {
    const [day] = expandPickedDays(["2027-03-13"], 18 * 60, 12 * 60, CHI);
    expect(slotsIn(day)).toHaveLength(24);
  });
});

describe("lockIsStillAhead", () => {
  it("is true when the lock is a second ahead", () => {
    expect(lockIsStillAhead(1_000_001, 1_000_000)).toBe(true);
  });

  it("is false when the lock equals now", () => {
    expect(lockIsStillAhead(1_000_000, 1_000_000)).toBe(false);
  });

  it("is false when the lock is in the past", () => {
    expect(lockIsStillAhead(999_999, 1_000_000)).toBe(false);
  });
});
