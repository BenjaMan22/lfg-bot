import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  MAX_WINDOW_HOURS,
  expandDays,
  formatDayLabel,
  formatSlotLabel,
  slotLabels,
  slotsIn,
} from "./timeblocks.js";

const CHI = "America/Chicago";

describe("expandDays", () => {
  it("expands an evening window into UTC instants", () => {
    const [day] = expandDays(["2026-08-28"], { startMinutes: 18 * 60, endMinutes: 23 * 60 }, CHI);
    expect(DateTime.fromSeconds(day.startUtc, { zone: CHI }).hour).toBe(18);
    expect(DateTime.fromSeconds(day.endUtc, { zone: CHI }).hour).toBe(23);
    expect(slotsIn(day)).toHaveLength(10);
  });

  it("carries a window that crosses midnight into the next day", () => {
    const [day] = expandDays(["2026-08-28"], { startMinutes: 18 * 60, endMinutes: 1 * 60 }, CHI);
    const end = DateTime.fromSeconds(day.endUtc, { zone: CHI });
    expect(end.day).toBe(29);
    expect(end.hour).toBe(1);
    expect(slotsIn(day)).toHaveLength(14);
  });

  it("numbers days from zero in order", () => {
    const days = expandDays(
      ["2026-08-28", "2026-08-29"],
      { startMinutes: 18 * 60, endMinutes: 22 * 60 },
      CHI,
    );
    expect(days.map((d) => d.dayIndex)).toEqual([0, 1]);
  });

  it("produces one fewer hour across a spring-forward transition", () => {
    // US DST begins 2027-03-14; 2am local does not exist.
    const [day] = expandDays(["2027-03-13"], { startMinutes: 22 * 60, endMinutes: 5 * 60 }, CHI);
    // 10pm to 5am is 7 wall-clock hours but only 6 real ones that night.
    expect(slotsIn(day)).toHaveLength(12);
  });

  it("emits slots exactly half an hour apart, aligned to the half hour", () => {
    const [day] = expandDays(["2026-08-28"], { startMinutes: 18 * 60, endMinutes: 23 * 60 }, CHI);
    const slots = slotsIn(day);
    expect(slots.every((s) => s % 1800 === 0)).toBe(true);
    expect(slots[1] - slots[0]).toBe(1800);
  });
});

describe("formatting", () => {
  it("labels hours compactly in the target zone", () => {
    const [day] = expandDays(["2026-08-28"], { startMinutes: 18 * 60, endMinutes: 23 * 60 }, CHI);
    expect(formatSlotLabel(slotsIn(day)[0], CHI)).toBe("6p");
  });

  it("labels midnight and noon unambiguously", () => {
    const [day] = expandDays(["2026-08-28"], { startMinutes: 12 * 60, endMinutes: 14 * 60 }, CHI);
    const hours = slotsIn(day);
    expect(formatSlotLabel(hours[0], CHI)).toBe("12p");
    expect(formatSlotLabel(hours[0] + 12 * 3600, CHI)).toBe("12a");
  });

  it("renders the same instant differently per viewer zone", () => {
    const [day] = expandDays(["2026-08-28"], { startMinutes: 18 * 60, endMinutes: 23 * 60 }, CHI);
    expect(formatSlotLabel(slotsIn(day)[0], "America/New_York")).toBe("7p");
  });

  it("labels a day", () => {
    const [day] = expandDays(["2026-08-28"], { startMinutes: 18 * 60, endMinutes: 23 * 60 }, CHI);
    expect(formatDayLabel(day, CHI)).toBe("Fri Aug 28");
  });
});

describe("slotLabels", () => {
  it("labels ordinary slots exactly as formatSlotLabel does", () => {
    const [day] = expandDays(["2026-08-28"], { startMinutes: 18 * 60, endMinutes: 20 * 60 }, CHI);
    expect(slotLabels(slotsIn(day), CHI)).toEqual(["6p", "6:30p", "7p", "7:30p"]);
  });

  it("distinguishes the repeated hour on a DST fall-back night", () => {
    // 2026-11-01 in America/Chicago: 2am CDT rewinds to 1am CST, so the
    // window contains two distinct instants that both read "1a". In an
    // availability dropdown that is unpickable — the two options are
    // indistinguishable, and one of them is an hour the player did not mean.
    // Midnight CDT through 3am CST; endUtc is exclusive, so 2a is the last hour.
    const day = { dayIndex: 0, startUtc: 1793509200, endUtc: 1793523600 };
    const labels = slotLabels(slotsIn(day), CHI);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual([
      "12a",
      "12:30a",
      "1a",
      "1:30a",
      "1a (again)",
      "1:30a (again)",
      "2a",
      "2:30a",
    ]);
  });
});

describe("half-hour granularity", () => {
  it("expands a day into half-hour instants", () => {
    const [day] = expandDays(["2026-08-28"], { startMinutes: 18 * 60, endMinutes: 20 * 60 }, CHI);
    const slots = slotsIn(day);
    expect(slots).toHaveLength(4);
    expect(slots[1] - slots[0]).toBe(1800);
  });

  it("honours a half-hour start when expanding", () => {
    const [day] = expandDays(
      ["2026-08-28"],
      { startMinutes: 18 * 60 + 30, endMinutes: 20 * 60 },
      CHI,
    );
    expect(DateTime.fromSeconds(day.startUtc, { zone: CHI }).toFormat("H:mm")).toBe("18:30");
    expect(slotsIn(day)).toHaveLength(3);
  });

  it("labels a half-hour slot distinguishably from the hour", () => {
    const [day] = expandDays(["2026-08-28"], { startMinutes: 18 * 60, endMinutes: 20 * 60 }, CHI);
    const slots = slotsIn(day);
    expect(formatSlotLabel(slots[0], CHI)).toBe("6p");
    expect(formatSlotLabel(slots[1], CHI)).toBe("6:30p");
  });

  it("caps the window so a day's slots still fit one Discord select", () => {
    // A select menu holds 25 options and availability is one option per slot,
    // so the longest window that can be answered at all is 12 hours.
    expect(MAX_WINDOW_HOURS * 2).toBeLessThanOrEqual(25);
  });
});
