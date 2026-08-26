import { DateTime } from "luxon";

export class TimeParseError extends Error {}

export interface HourWindow {
  startHour: number;
  endHour: number;
}

export interface NightDay {
  dayIndex: number;
  startUtc: number;
  endUtc: number;
}

export const MAX_DAYS = 5;
/**
 * Longest evening window a night may cover. Not an arbitrary tidiness rule:
 * every hour becomes a column in the poll's availability grid and an option
 * in a per-day dropdown, and `12am-11pm` across five days pushes the grid
 * past the 1024-character limit on an embed field — which discord.js rejects
 * by throwing, so the poll would never post at all.
 */
export const MAX_WINDOW_HOURS = 16;

const TIME = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;

function parseClockHour(raw: string, whole: string): number {
  const match = TIME.exec(raw.trim());
  if (!match) {
    throw new TimeParseError(
      `I could not read "${whole}" as a time window. Try something like \`6pm-1am\` or \`18-01\`.`,
    );
  }
  const [, hourText, minuteText, meridiem] = match;
  if (minuteText && minuteText !== "00") {
    throw new TimeParseError(
      `Availability is tracked in whole hours, so "${raw.trim()}" will not work. Use \`6pm\`, not \`6:30pm\`.`,
    );
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
  return hour % 24;
}

/**
 * How many whole hours a window covers. An end hour at or before the start
 * means it crosses midnight into the following day.
 */
export function windowHours(window: HourWindow): number {
  const { startHour, endHour } = window;
  return endHour > startHour ? endHour - startHour : 24 - startHour + endHour;
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
  window: HourWindow,
): void {
  const available = windowHours(window);
  if (minSessionHours > available) {
    throw new TimeParseError(
      `A shortest session of ${minSessionHours} hours cannot fit in a ${available}-hour window — no night could ever qualify. Shorten the session, or widen the window.`,
    );
  }
}

export function parseWindow(input: string): HourWindow {
  const parts = input.split("-");
  if (parts.length !== 2) {
    throw new TimeParseError(
      `I could not read "${input}" as a time window. Try something like \`6pm-1am\`.`,
    );
  }
  const startHour = parseClockHour(parts[0], input);
  const endHour = parseClockHour(parts[1], input);
  if (startHour === endHour) {
    throw new TimeParseError("A game night window needs to be at least one hour long.");
  }
  const length = windowHours({ startHour, endHour });
  if (length > MAX_WINDOW_HOURS) {
    throw new TimeParseError(
      `A window can be at most ${MAX_WINDOW_HOURS} hours long, and "${input}" is ${length}. Narrow it to the hours people might actually play, like \`6pm-1am\`.`,
    );
  }
  return { startHour, endHour };
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
  window: HourWindow,
  tz: string,
): NightDay[] {
  return isoDates.map((iso, dayIndex) => {
    const base = DateTime.fromISO(iso, { zone: tz }).startOf("day");
    const start = base.set({ hour: window.startHour });
    const crossesMidnight = window.endHour <= window.startHour;
    const end = (crossesMidnight ? base.plus({ days: 1 }) : base).set({
      hour: window.endHour,
    });
    return { dayIndex, startUtc: start.toUnixInteger(), endUtc: end.toUnixInteger() };
  });
}

export function hoursIn(day: NightDay): number[] {
  const hours: number[] = [];
  for (let t = day.startUtc; t < day.endUtc; t += 3600) hours.push(t);
  return hours;
}

export function parseDeadline(input: string, tz: string, now: DateTime): number {
  const text = input.trim().toLowerCase();
  const base = now.setZone(tz);
  let result: DateTime | null = null;

  const relative = /^(\d+)\s*(h|hr|hrs|hour|hours|d|day|days)$/.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    result = relative[2].startsWith("h")
      ? base.plus({ hours: amount })
      : base.plus({ days: amount });
  }

  if (!result) {
    const absolute = DateTime.fromISO(text.replace(" ", "T"), { zone: tz });
    if (absolute.isValid) result = absolute;
  }

  if (!result) {
    const weekdayTime = /^([a-z]+)\s+(.+)$/.exec(text);
    if (weekdayTime && WEEKDAYS[weekdayTime[1]] !== undefined) {
      const iso = resolveDayToken(weekdayTime[1], tz, now);
      const hour = parseClockHour(weekdayTime[2], input);
      result = DateTime.fromISO(iso, { zone: tz }).set({ hour });
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

export function formatHourLabel(utcHour: number, tz: string): string {
  const local = DateTime.fromSeconds(utcHour, { zone: tz });
  const hour12 = local.hour % 12 === 0 ? 12 : local.hour % 12;
  return `${hour12}${local.hour < 12 ? "a" : "p"}`;
}

export function formatDayLabel(day: NightDay, tz: string): string {
  return DateTime.fromSeconds(day.startUtc, { zone: tz }).toFormat("ccc LLL d");
}

/**
 * Hour labels for a set of instants, guaranteed distinct.
 *
 * On a DST fall-back night the clock repeats an hour, so two different
 * instants format identically — "1a" and "1a". `hoursIn` correctly yields
 * both, because both are real playable hours, but a dropdown offering two
 * identical options is unusable: whichever the player picks, they have a 50%
 * chance of claiming an hour they did not mean. Marking the repeat keeps the
 * options tellable apart, in the order they actually happen.
 */
export function hourLabels(hours: number[], tz: string): string[] {
  const seen = new Map<string, number>();
  return hours.map((hour) => {
    const label = formatHourLabel(hour, tz);
    const previous = seen.get(label) ?? 0;
    seen.set(label, previous + 1);
    return previous === 0 ? label : `${label} (again)`;
  });
}
