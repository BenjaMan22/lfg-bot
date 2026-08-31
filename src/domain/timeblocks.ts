import { DateTime } from "luxon";

export class TimeParseError extends Error {}

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
const SLOT_MINUTES = 30;
const MINUTES_PER_DAY = 24 * 60;

export interface NightDay {
  dayIndex: number;
  startUtc: number;
  endUtc: number;
}

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

const TIME = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;

export interface ClockTime {
  hour: number;
  minute: number;
}

/**
 * A clock time to the minute, in 12- or 24-hour form.
 *
 * `unreadable` is the message used when the text is not a time at all, since
 * the two callers are parsing quite different things — half of a window, or a
 * deadline — and "I could not read this as a time window" is nonsense when
 * the host was typing a deadline.
 */
function parseClockTime(raw: string, unreadable: string): ClockTime {
  const match = TIME.exec(raw.trim());
  if (!match) throw new TimeParseError(unreadable);

  const [, hourText, minuteText, meridiem] = match;
  const minute = minuteText ? Number(minuteText) : 0;
  if (minute > 59) {
    throw new TimeParseError(`"${raw.trim()}" is not a valid time.`);
  }
  let hour = Number(hourText);
  if (meridiem) {
    if (hour < 1 || hour > 12) {
      throw new TimeParseError(`"${raw.trim()}" is not a valid 12-hour time.`);
    }
    if (hour === 12) hour = 0;
    if (meridiem.toLowerCase() === "pm") hour += 12;
  } else if (hour < 0 || hour > 24) {
    throw new TimeParseError(`"${raw.trim()}" is not a valid hour.`);
  }
  return { hour: hour % 24, minute };
}

/**
 * A window boundary, as minutes from midnight, snapped to a slot.
 *
 * Only windows need this restriction: availability is one row per half-hour
 * slot, so 6:20 is not a boundary the grid can represent. Deadlines are plain
 * instants and deliberately do NOT go through here — sharing a granularity
 * rule with them is what used to force a host clear of their own start time.
 */
function parseSlotMinutes(raw: string, whole: string): number {
  const { hour, minute } = parseClockTime(
    raw,
    `I could not read "${whole}" as a time window. Try something like \`6pm-1am\` or \`18-01\`.`,
  );
  if (minute % SLOT_MINUTES !== 0) {
    throw new TimeParseError(
      `Availability moves in half hours, so "${raw.trim()}" will not work. Use \`6pm\` or \`6:30pm\`.`,
    );
  }
  return hour * 60 + minute;
}

/** Minutes a window covers, wrapping past midnight when it needs to. */
function windowMinutes(window: DayWindow): number {
  const { startMinutes, endMinutes } = window;
  return endMinutes > startMinutes
    ? endMinutes - startMinutes
    : MINUTES_PER_DAY - startMinutes + endMinutes;
}

/** How many half-hour availability slots a window covers. */
export function windowSlots(window: DayWindow): number {
  return windowMinutes(window) / SLOT_MINUTES;
}

/**
 * A session that cannot fit inside its own window is unschedulable by
 * construction: `rankNight` enumerates runs of at least `minSessionHours`, so
 * a longer minimum means the run loop never executes and every night reports
 * nothing viable — with no near misses either, since no run was ever built to
 * miss by. Caught at creation, where the host can still fix it, rather than
 * silently at the deadline after everyone has already answered.
 */
export function assertSessionFitsWindow(
  minSessionHours: number,
  window: DayWindow,
): void {
  const available = windowMinutes(window) / 60;
  if (minSessionHours > available) {
    throw new TimeParseError(
      `A game night needs ${minSessionHours} hours in a row to be worth scheduling, and this window is only ${available}. Widen it — something like \`6pm-1am\`.`,
    );
  }
}

export function parseWindow(input: string): DayWindow {
  const parts = input.split("-");
  if (parts.length !== 2) {
    throw new TimeParseError(
      `I could not read "${input}" as a time window. Try something like \`6pm-1am\`.`,
    );
  }
  const startMinutes = parseSlotMinutes(parts[0], input);
  const endMinutes = parseSlotMinutes(parts[1], input);
  if (startMinutes === endMinutes) {
    throw new TimeParseError("A game night window needs to be at least half an hour long.");
  }
  const hours = windowMinutes({ startMinutes, endMinutes }) / 60;
  if (hours > MAX_WINDOW_HOURS) {
    throw new TimeParseError(
      `A window can be at most ${MAX_WINDOW_HOURS} hours long, and "${input}" is ${hours}. Narrow it to the hours people might actually play, like \`6pm-1am\`.`,
    );
  }
  return { startMinutes, endMinutes };
}

const WEEKDAYS: Record<string, number> = {
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
  sun: 7, sunday: 7,
};

function resolveDayToken(token: string, tz: string, now: DateTime): string {
  const text = token.trim().toLowerCase();
  const today = now.setZone(tz).startOf("day");

  const weekday = WEEKDAYS[text];
  if (weekday !== undefined) {
    // Luxon weekdays are 1 (Monday) through 7 (Sunday).
    const delta = (weekday - today.weekday + 7) % 7;
    return today.plus({ days: delta }).toISODate()!;
  }

  const iso = DateTime.fromISO(text, { zone: tz });
  if (iso.isValid) return iso.startOf("day").toISODate()!;

  const slash = /^(\d{1,2})\/(\d{1,2})$/.exec(text);
  if (slash) {
    const [, month, day] = slash;
    let candidate = DateTime.fromObject(
      { year: today.year, month: Number(month), day: Number(day) },
      { zone: tz },
    );
    if (!candidate.isValid) {
      throw new TimeParseError(`"${token.trim()}" is not a real date.`);
    }
    if (candidate < today) candidate = candidate.plus({ years: 1 });
    return candidate.toISODate()!;
  }

  throw new TimeParseError(
    `I could not read "${token.trim()}" as a day. Use a weekday (\`fri\`), a date (\`2026-08-28\`), or \`MM/DD\`.`,
  );
}

export function parseDays(input: string, tz: string, now: DateTime): string[] {
  const tokens = input.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new TimeParseError("Give me at least one day, like `fri,sat`.");
  }
  const dates = [...new Set(tokens.map((t) => resolveDayToken(t, tz, now)))].sort();
  if (dates.length > MAX_DAYS) {
    throw new TimeParseError(
      `A game night can cover at most ${MAX_DAYS} days — Discord only allows five dropdowns in one message. You gave ${dates.length}.`,
    );
  }
  return dates;
}

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

export function parseDeadline(input: string, tz: string, now: DateTime): number {
  const text = input.trim().toLowerCase();
  const base = now.setZone(tz);
  let result: DateTime | null = null;

  const relative =
    /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    // Ordered longest-prefix first: "m" must not be mistaken for the "m" that
    // starts "minutes" only after "h"/"d" have had their turn.
    if (unit.startsWith("m")) result = base.plus({ minutes: amount });
    else if (unit.startsWith("h")) result = base.plus({ hours: amount });
    else result = base.plus({ days: amount });
  }

  if (!result) {
    const absolute = DateTime.fromISO(text.replace(" ", "T"), { zone: tz });
    if (absolute.isValid) result = absolute;
  }

  if (!result) {
    const weekdayTime = /^([a-z]+)\s+(.+)$/.exec(text);
    if (weekdayTime && WEEKDAYS[weekdayTime[1]] !== undefined) {
      const iso = resolveDayToken(weekdayTime[1], tz, now);
      // To the minute: a deadline is an instant, not an availability slot.
      const { hour, minute } = parseClockTime(
        weekdayTime[2],
        `I could not read "${input}" as a deadline. Try \`thu 9pm\`, \`24h\`, or \`2026-08-27 21:00\`.`,
      );
      result = DateTime.fromISO(iso, { zone: tz }).set({ hour, minute });
      // "thu 9pm" when it is already Thursday 10pm means next Thursday.
      if (result <= base) result = result.plus({ weeks: 1 });
    }
  }

  if (!result || !result.isValid) {
    throw new TimeParseError(
      `I could not read "${input}" as a deadline. Try \`thu 9pm\`, \`24h\`, or \`2026-08-27 21:00\`.`,
    );
  }
  if (result <= base) {
    throw new TimeParseError("The deadline needs to be in the future.");
  }
  return result.toUnixInteger();
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
