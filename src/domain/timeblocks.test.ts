import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  TimeParseError,
  assertSessionFitsWindow,
  expandDays,
  formatDayLabel,
  formatHourLabel,
  hourLabels,
  hoursIn,
  parseDays,
  parseDeadline,
  parseWindow,
  windowHours,
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

  it("rejects a window longer than the maximum", () => {
    // 23 hours across 5 days would push the availability grid past the
    // 1024-character embed field limit, which throws rather than truncates.
    expect(() => parseWindow("12am-11pm")).toThrow(TimeParseError);
    expect(() => parseWindow("12am-11pm")).toThrow(/at most 16 hours/i);
  });

  it("rejects an over-long window that crosses midnight", () => {
    expect(() => parseWindow("6pm-11am")).toThrow(/at most 16 hours/i);
  });

  it("accepts a window exactly at the maximum", () => {
    expect(parseWindow("6am-10pm")).toEqual({ startHour: 6, endHour: 22 });
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

describe("windowHours", () => {
  it("measures an evening window", () => {
    expect(windowHours({ startHour: 18, endHour: 22 })).toBe(4);
  });

  it("measures a window that crosses midnight", () => {
    expect(windowHours({ startHour: 18, endHour: 1 })).toBe(7);
  });
});

describe("assertSessionFitsWindow", () => {
  it("accepts a session the window can hold", () => {
    expect(() => assertSessionFitsWindow(4, { startHour: 18, endHour: 1 })).not.toThrow();
  });

  it("accepts a session exactly as long as the window", () => {
    expect(() => assertSessionFitsWindow(4, { startHour: 18, endHour: 22 })).not.toThrow();
  });

  it("rejects a session longer than the window it must fit in", () => {
    // Regression: `minhours` was only range-checked (1-12) in isolation, never
    // against the window. A 4-hour window with minhours 12 was accepted, and
    // rankNight's run loop then never executed — so the poll ran its full
    // course and reported "No viable night" with no near misses to explain it.
    expect(() => assertSessionFitsWindow(12, { startHour: 18, endHour: 22 })).toThrow(
      TimeParseError,
    );
  });

  it("explains both numbers so the host can fix it", () => {
    expect(() => assertSessionFitsWindow(12, { startHour: 18, endHour: 22 })).toThrow(
      /12.*4|4.*12/,
    );
  });
});

describe("hourLabels", () => {
  it("labels ordinary hours exactly as formatHourLabel does", () => {
    const [day] = expandDays(["2026-08-28"], { startHour: 18, endHour: 21 }, CHI);
    expect(hourLabels(hoursIn(day), CHI)).toEqual(["6p", "7p", "8p"]);
  });

  it("distinguishes the repeated hour on a DST fall-back night", () => {
    // 2026-11-01 in America/Chicago: 2am CDT rewinds to 1am CST, so the
    // window contains two distinct instants that both read "1a". In an
    // availability dropdown that is unpickable — the two options are
    // indistinguishable, and one of them is an hour the player did not mean.
    // Midnight CDT through 3am CST; endUtc is exclusive, so 2a is the last hour.
    const day = { dayIndex: 0, startUtc: 1793509200, endUtc: 1793523600 };
    const labels = hourLabels(hoursIn(day), CHI);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(["12a", "1a", "1a (again)", "2a"]);
  });
});

describe("parseDeadline minute precision", () => {
  it("accepts a weekday time with minutes", () => {
    // Regression: parseClockHour is shared with parseWindow, which rejects
    // non-zero minutes because availability is stored per hour. A deadline is
    // just an instant and has no such constraint — but it inherited the
    // restriction, which forced hosts a full hour clear of their start time.
    const expected = DateTime.fromISO("2026-08-27T18:50:00", { zone: CHI });
    expect(parseDeadline("thu 6:50pm", CHI, NOW)).toBe(expected.toUnixInteger());
  });

  it("accepts a 24-hour weekday time with minutes", () => {
    const expected = DateTime.fromISO("2026-08-27T21:45:00", { zone: CHI });
    expect(parseDeadline("thu 21:45", CHI, NOW)).toBe(expected.toUnixInteger());
  });

  it("still accepts a whole-hour weekday time", () => {
    const expected = DateTime.fromISO("2026-08-27T21:00:00", { zone: CHI });
    expect(parseDeadline("thu 9pm", CHI, NOW)).toBe(expected.toUnixInteger());
  });

  it("accepts minutes in an absolute date and time", () => {
    const expected = DateTime.fromISO("2026-08-27T21:30:00", { zone: CHI });
    expect(parseDeadline("2026-08-27 21:30", CHI, NOW)).toBe(expected.toUnixInteger());
  });

  it("rolls to next week using the full time, not just the hour", () => {
    // 12:30pm on the NOW Tuesday is already past (NOW is 12:00 plus nothing),
    // so "tue 11:30am" must land a week out rather than earlier today.
    const result = parseDeadline("tue 11:30am", CHI, NOW);
    expect(result).toBe(
      DateTime.fromISO("2026-09-01T11:30:00", { zone: CHI }).toUnixInteger(),
    );
  });

  it("still rejects minutes in a window, where hours are load-bearing", () => {
    expect(() => parseWindow("6:50pm-11pm")).toThrow(/whole hours/i);
  });
});

describe("relative deadlines in minutes", () => {
  it("accepts a relative duration in minutes", () => {
    expect(parseDeadline("90m", CHI, NOW)).toBe(NOW.plus({ minutes: 90 }).toUnixInteger());
  });

  it("accepts the spelled-out form", () => {
    expect(parseDeadline("45 minutes", CHI, NOW)).toBe(
      NOW.plus({ minutes: 45 }).toUnixInteger(),
    );
  });

  it("still reads h as hours, not minutes", () => {
    expect(parseDeadline("2h", CHI, NOW)).toBe(NOW.plus({ hours: 2 }).toUnixInteger());
  });

  it("still reads d as days", () => {
    expect(parseDeadline("2d", CHI, NOW)).toBe(NOW.plus({ days: 2 }).toUnixInteger());
  });
});
