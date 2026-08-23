import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  TimeParseError,
  expandDays,
  formatDayLabel,
  formatHourLabel,
  hoursIn,
  parseDays,
  parseDeadline,
  parseWindow,
} from "./timeblocks.js";

const CHI = "America/Chicago";
// A Tuesday.
const NOW = DateTime.fromISO("2026-08-25T12:00:00", { zone: CHI });

describe("parseWindow", () => {
  it("parses 12-hour with meridiems", () => {
    expect(parseWindow("6pm-1am")).toEqual({ startHour: 18, endHour: 1 });
  });

  it("parses 24-hour", () => {
    expect(parseWindow("18-01")).toEqual({ startHour: 18, endHour: 1 });
  });

  it("accepts explicit zero minutes", () => {
    expect(parseWindow("6:00pm-11:00pm")).toEqual({ startHour: 18, endHour: 23 });
  });

  it("treats 12am as midnight and 12pm as noon", () => {
    expect(parseWindow("12pm-12am")).toEqual({ startHour: 12, endHour: 0 });
  });

  it("rejects non-zero minutes with an explanation", () => {
    expect(() => parseWindow("6:30pm-11pm")).toThrow(TimeParseError);
    expect(() => parseWindow("6:30pm-11pm")).toThrow(/whole hours/i);
  });

  it("rejects a window of zero length", () => {
    expect(() => parseWindow("8pm-8pm")).toThrow(/at least one hour/i);
  });

  it("rejects gibberish", () => {
    expect(() => parseWindow("evening")).toThrow(TimeParseError);
  });
});

describe("parseDays", () => {
  it("resolves weekday names to the next occurrence", () => {
    expect(parseDays("fri,sat", CHI, NOW)).toEqual(["2026-08-28", "2026-08-29"]);
  });

  it("resolves a weekday name for today to today", () => {
    expect(parseDays("tue", CHI, NOW)).toEqual(["2026-08-25"]);
  });

  it("accepts long names, ISO dates, and MM/DD together, sorted and deduped", () => {
    expect(parseDays("friday, 2026-08-28, 08/30", CHI, NOW)).toEqual([
      "2026-08-28",
      "2026-08-30",
    ]);
  });

  it("rolls MM/DD into next year when it has already passed", () => {
    expect(parseDays("01/03", CHI, NOW)).toEqual(["2027-01-03"]);
  });

  it("rejects more than five days", () => {
    expect(() => parseDays("mon,tue,wed,thu,fri,sat", CHI, NOW)).toThrow(/5 days/);
  });

  it("rejects an empty list", () => {
    expect(() => parseDays("  ", CHI, NOW)).toThrow(TimeParseError);
  });

  it("rejects an unparseable token by name", () => {
    expect(() => parseDays("fri,someday", CHI, NOW)).toThrow(/someday/);
  });
});

describe("expandDays", () => {
  it("expands an evening window into UTC instants", () => {
    const [day] = expandDays(["2026-08-28"], { startHour: 18, endHour: 23 }, CHI);
    expect(DateTime.fromSeconds(day.startUtc, { zone: CHI }).hour).toBe(18);
    expect(DateTime.fromSeconds(day.endUtc, { zone: CHI }).hour).toBe(23);
    expect(hoursIn(day)).toHaveLength(5);
  });

  it("carries a window that crosses midnight into the next day", () => {
    const [day] = expandDays(["2026-08-28"], { startHour: 18, endHour: 1 }, CHI);
    const end = DateTime.fromSeconds(day.endUtc, { zone: CHI });
    expect(end.day).toBe(29);
    expect(end.hour).toBe(1);
    expect(hoursIn(day)).toHaveLength(7);
  });

  it("numbers days from zero in order", () => {
    const days = expandDays(
      ["2026-08-28", "2026-08-29"],
      { startHour: 18, endHour: 22 },
      CHI,
    );
    expect(days.map((d) => d.dayIndex)).toEqual([0, 1]);
  });

  it("produces one fewer hour across a spring-forward transition", () => {
    // US DST begins 2027-03-14; 2am local does not exist.
    const [day] = expandDays(["2027-03-13"], { startHour: 22, endHour: 5 }, CHI);
    // 10pm to 5am is 7 wall-clock hours but only 6 real ones that night.
    expect(hoursIn(day)).toHaveLength(6);
  });

  it("emits hours exactly one hour apart, aligned to the hour", () => {
    const [day] = expandDays(["2026-08-28"], { startHour: 18, endHour: 23 }, CHI);
    const hours = hoursIn(day);
    expect(hours.every((h) => h % 3600 === 0)).toBe(true);
    expect(hours[1] - hours[0]).toBe(3600);
  });
});

describe("parseDeadline", () => {
  it("parses a relative duration in hours", () => {
    expect(parseDeadline("24h", CHI, NOW)).toBe(NOW.plus({ hours: 24 }).toUnixInteger());
  });

  it("parses a relative duration in days", () => {
    expect(parseDeadline("2d", CHI, NOW)).toBe(NOW.plus({ days: 2 }).toUnixInteger());
  });

  it("parses a weekday and time in the given zone", () => {
    const expected = DateTime.fromISO("2026-08-27T21:00:00", { zone: CHI });
    expect(parseDeadline("thu 9pm", CHI, NOW)).toBe(expected.toUnixInteger());
  });

  it("parses an absolute date and time", () => {
    const expected = DateTime.fromISO("2026-08-27T21:00:00", { zone: CHI });
    expect(parseDeadline("2026-08-27 21:00", CHI, NOW)).toBe(expected.toUnixInteger());
  });

  it("rejects a deadline in the past", () => {
    expect(() => parseDeadline("2026-08-24 21:00", CHI, NOW)).toThrow(/future/i);
  });

  it("rejects gibberish", () => {
    expect(() => parseDeadline("soon", CHI, NOW)).toThrow(TimeParseError);
  });
});

describe("formatting", () => {
  it("labels hours compactly in the target zone", () => {
    const [day] = expandDays(["2026-08-28"], { startHour: 18, endHour: 23 }, CHI);
    expect(formatHourLabel(hoursIn(day)[0], CHI)).toBe("6p");
  });

  it("labels midnight and noon unambiguously", () => {
    const [day] = expandDays(["2026-08-28"], { startHour: 12, endHour: 14 }, CHI);
    const hours = hoursIn(day);
    expect(formatHourLabel(hours[0], CHI)).toBe("12p");
    expect(formatHourLabel(hours[0] + 12 * 3600, CHI)).toBe("12a");
  });

  it("renders the same instant differently per viewer zone", () => {
    const [day] = expandDays(["2026-08-28"], { startHour: 18, endHour: 23 }, CHI);
    expect(formatHourLabel(hoursIn(day)[0], "America/New_York")).toBe("7p");
  });

  it("labels a day", () => {
    const [day] = expandDays(["2026-08-28"], { startHour: 18, endHour: 23 }, CHI);
    expect(formatDayLabel(day, CHI)).toBe("Fri Aug 28");
  });
});
